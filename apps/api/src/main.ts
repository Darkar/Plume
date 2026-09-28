import { ConfigError, ConfigStore, readSecret, readSecretFile } from '@plume/config';
import { parseMasterKey, SecretBox } from '@plume/crypto';
import { createDb, migrate, pingDb } from '@plume/db';
import { loginFor, safeFetchImage, serverFor, verifyImapLogin } from '@plume/mail';
import { createLogger, createRedis } from '@plume/shared';
import { buildApp } from './app.js';
import { createServices } from './context.js';
import { UrlSigner } from './lib/signing.js';
import { enforceWhitelist } from './services/whitelist.js';

async function main(): Promise<void> {
  const configPath = process.env.PLUME_CONFIG ?? '/etc/plume/plume.yaml';
  let store: ConfigStore;
  try {
    store = new ConfigStore(configPath);
  } catch (error) {
    // Message clair, sans pile d'appels : c'est une erreur d'exploitation, pas un bogue.
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exit(78); // EX_CONFIG
  }
  const config = store.current;
  const logger = createLogger({ ...config.logging, name: 'plume-api' });

  const masterKey = parseMasterKey(readSecretFile(config.security.master_key_file));
  const box = new SecretBox(masterKey);
  const database = createDb(readSecret(config.database));
  const applied = await migrate(database.pool);
  if (applied.length > 0) logger.info({ migrations: applied }, 'migrations appliquées');

  const redis = createRedis(readSecret(config.redis));
  redis.on('error', (err) => logger.warn({ err }, 'redis : erreur de connexion'));

  const services = createServices(() => store.current, logger, {
    db: database,
    redis,
    box,
    verifyLogin: (domain, email, password) =>
      verifyImapLogin(serverFor(domain, 'imap'), loginFor(domain, email), password),
    signer: new UrlSigner(masterKey),
    fetchImage: (url) => safeFetchImage(url),
  });

  const app = await buildApp({
    config: () => store.current,
    logger,
    services,
    readinessChecks: [
      { name: 'postgres', check: () => pingDb(database.pool) },
      { name: 'redis', check: async () => void (await redis.ping()) },
    ],
  });

  process.on('SIGHUP', () => {
    try {
      const result = store.reload();
      logger.info(
        { removedDomains: result.removedDomains, ignoredSections: result.ignoredSections },
        'configuration rechargée',
      );
      enforceWhitelist(services).catch((err: unknown) =>
        logger.error({ err }, 'échec de la révocation des domaines retirés'),
      );
    } catch (error) {
      logger.error(
        { err: error },
        'rechargement refusé : configuration invalide, ancienne conservée',
      );
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'arrêt en cours');
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    try {
      await app.close();
      await Promise.allSettled([database.close(), redis.quit()]);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await enforceWhitelist(services);
  await app.listen({ host: config.server.listen.host, port: config.server.listen.port });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Échec du démarrage : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
