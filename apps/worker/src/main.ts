import { ConfigError, ConfigStore, readSecret, readSecretFile } from '@plume/config';
import { parseMasterKey, SecretBox } from '@plume/crypto';
import { createDb, pingDb, RulesRepository, SnoozesRepository } from '@plume/db';
import {
  createLogger,
  createRedis,
  RULES_CHANGED_CHANNEL,
  RULES_QUEUE,
  type ApplyExistingJob,
  type ProcessNewJob,
} from '@plume/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { accountResolver } from './accounts.js';
import { createHealthServer } from './health.js';
import { AccountUnavailable, RuleProcessor } from './processor.js';
import { sendDueDigests } from './digest.js';
import { wakeDueSnoozes } from './snoozes.js';
import { IdleWatchers } from './watcher.js';

const HEALTH_PORT = Number(process.env.PLUME_HEALTH_PORT ?? 3001);
const SYNC_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const PURGE_INTERVAL_MS = 24 * 3_600_000;
const SNOOZE_INTERVAL_MS = 30_000;
const DIGEST_INTERVAL_MS = 10 * 60_000;

async function main(): Promise<void> {
  const configPath = process.env.PLUME_CONFIG ?? '/etc/plume/plume.yaml';
  let store: ConfigStore;
  try {
    store = new ConfigStore(configPath);
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exit(78);
  }
  const config = store.current;
  const logger = createLogger({ ...config.logging, name: 'plume-worker' });
  const box = new SecretBox(parseMasterKey(readSecretFile(config.security.master_key_file)));
  const database = createDb(readSecret(config.database), { max: 5 });
  const redisUrl = readSecret(config.redis);
  const redis = createRedis(redisUrl, { maxRetriesPerRequest: null });
  const subscriber = createRedis(redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', (err) => logger.warn({ err }, 'redis : erreur de connexion'));
  subscriber.on('error', () => undefined);

  const repo = new RulesRepository(database.db);
  const snoozes = new SnoozesRepository(database.db);
  const account = accountResolver(database.db, box, () => store.current);
  const processor = new RuleProcessor({ config: () => store.current, logger, repo, account });
  const queue = new Queue(RULES_QUEUE, { connection: redis });

  const notify = (userId: string, mailbox: string) => {
    // Regroupe les notifications rapprochées (fenêtre de 5 s) en un seul traitement.
    const bucket = Math.floor(Date.now() / 5_000);
    void queue
      .add('process-new', { userId, mailbox } satisfies ProcessNewJob, {
        jobId: `new-${userId}-${Buffer.from(mailbox).toString('base64url')}-${bucket}`,
        delay: 1_000,
        removeOnComplete: 1000,
        removeOnFail: 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      })
      .catch((err: unknown) => logger.error({ err }, 'mise en file impossible'));
  };

  const watchers = new IdleWatchers({ logger, account, notify });

  const worker = new Worker(
    RULES_QUEUE,
    async (job: Job) => {
      if (job.name === 'process-new') {
        const { userId, mailbox } = job.data as ProcessNewJob;
        try {
          const result = await processor.processNew(userId, mailbox);
          if (result.processed > 0) logger.info({ userId, ...result }, 'règles appliquées');
          return result;
        } catch (error) {
          if (error instanceof AccountUnavailable) {
            watchers.stop(userId);
            return { processed: 0, matched: 0 };
          }
          throw error;
        }
      }
      if (job.name === 'apply-existing') {
        const { userId, ruleId, mailbox } = job.data as ApplyExistingJob;
        return processor.applyExisting(userId, ruleId, mailbox, (done, total) =>
          job.updateProgress({ done, total }),
        );
      }
      throw new Error(`tâche inconnue : ${job.name}`);
    },
    { connection: createRedis(redisUrl, { maxRetriesPerRequest: null }), concurrency: 5 },
  );
  worker.on('failed', (job, err) =>
    logger.warn({ job: job?.name, attempts: job?.attemptsMade, err }, 'tâche en échec'),
  );

  const sync = async () => {
    if (!store.current.rules.enabled) {
      watchers.sync([]);
      return [];
    }
    const users = await repo.usersWithActiveRules();
    watchers.sync(users);
    return users;
  };
  await sync().catch((err: unknown) =>
    logger.error({ err }, 'synchronisation initiale impossible'),
  );

  let wakingSnoozes = false;
  let sendingDigests = false;
  const timers = [
    setInterval(
      () =>
        void sync().catch((err: unknown) => logger.error({ err }, 'synchronisation impossible')),
      SYNC_INTERVAL_MS,
    ),
    // Repli : interrogation périodique (IDLE manqué, comptes au-delà du plafond de connexions).
    setInterval(() => {
      void sync().then(
        (users) => users.forEach((userId) => notify(userId, 'INBOX')),
        () => undefined,
      );
    }, POLL_INTERVAL_MS),
    setInterval(() => void repo.purgeProcessed(90).catch(() => undefined), PURGE_INTERVAL_MS),
    setInterval(() => {
      if (wakingSnoozes) return;
      wakingSnoozes = true;
      wakeDueSnoozes({ repo: snoozes, account, logger })
        .then((r) => {
          if (r.woken + r.dropped + r.failed > 0) logger.info(r, 'reports traités');
        })
        .catch((err: unknown) => logger.error({ err }, 'traitement des reports impossible'))
        .finally(() => {
          wakingSnoozes = false;
        });
    }, SNOOZE_INTERVAL_MS),
    setInterval(() => {
      if (sendingDigests) return;
      sendingDigests = true;
      sendDueDigests({ db: database.db, account, logger })
        .then((r) => {
          if (r.sent + r.failed > 0) logger.info(r, 'résumés quotidiens');
        })
        .catch((err: unknown) => logger.error({ err }, 'résumés quotidiens impossibles'))
        .finally(() => {
          sendingDigests = false;
        });
    }, DIGEST_INTERVAL_MS),
  ];

  await subscriber.subscribe(RULES_CHANGED_CHANNEL);
  subscriber.on('message', (_channel, userId: string) => {
    if (!/^[0-9a-f-]{36}$/.test(userId)) return;
    void sync().then(
      () => notify(userId, 'INBOX'),
      () => undefined,
    );
  });

  const health = createHealthServer({
    ready: async () => {
      await Promise.all([pingDb(database.pool), redis.ping()]);
      return true;
    },
  });
  health.listen(HEALTH_PORT, '0.0.0.0');

  process.on('SIGHUP', () => {
    try {
      const result = store.reload();
      logger.info({ removedDomains: result.removedDomains }, 'configuration rechargée');
      void sync();
    } catch (error) {
      logger.error({ err: error }, 'rechargement refusé : configuration invalide');
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'arrêt en cours');
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    timers.forEach(clearInterval);
    health.close();
    await worker.close();
    await watchers.close();
    await Promise.allSettled([queue.close(), database.close(), redis.quit(), subscriber.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info({ watching: watchers.watching.length }, 'worker démarré');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Échec du démarrage : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
