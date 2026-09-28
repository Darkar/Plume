import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { parseConfig, type PlumeConfig } from '@plume/config';
import { SecretBox } from '@plume/crypto';
import {
  createDb,
  IMAP_PASSWORD_CONTEXT,
  migrate,
  RulesRepository,
  SnoozesRepository,
  schema,
  type DbHandle,
} from '@plume/db';
import { ImapFlow, imapOptions, snoozeMessage, type sendRaw } from '@plume/mail';
import { ruleSchema, type RuleInput } from '@plume/rules';
import { createLogger } from '@plume/shared';
import { seedMailbox, startGreenMail, startPostgres, type StartedGreenMail } from '@plume/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { accountResolver } from '../src/accounts.js';
import { RuleProcessor } from '../src/processor.js';
import { wakeDueSnoozes } from '../src/snoozes.js';
import { sendDueDigests } from '../src/digest.js';

const SACHA = { email: 'sacha@exemple.com', password: 'imap-sacha' };
const ALICE = { email: 'alice@exemple.com', password: 'imap-alice' };

let pg: StartedPostgreSqlContainer;
let gm: StartedGreenMail;
let db: DbHandle;
let repo: RulesRepository;
let config: PlumeConfig;
let processor: RuleProcessor;
let userId: string;
const box = new SecretBox(randomBytes(32));
const send = vi.fn<typeof sendRaw>(async () => undefined);
const silent = new Writable({ write: (_c, _e, cb) => cb() });

beforeAll(async () => {
  [pg, gm] = await Promise.all([startPostgres(), startGreenMail([SACHA, ALICE])]);
  db = createDb(pg.getConnectionUri());
  await migrate(db.pool);
  repo = new RulesRepository(db.db);
  const raw = parse(
    readFileSync(new URL('../../../config/plume.example.yaml', import.meta.url), 'utf8'),
  );
  raw.domains[0].imap = { host: gm.host, port: gm.imapsPort, security: 'tls' };
  raw.domains[0].smtp = { host: gm.host, port: gm.smtpsPort, security: 'tls' };
  raw.domains[0].tls = { reject_unauthorized: false };
  config = parseConfig(stringify(raw));
  const [user] = await db.db
    .insert(schema.users)
    .values({ email: SACHA.email, domain: 'exemple.com' })
    .returning();
  userId = user!.id;
  await db.db.insert(schema.credentials).values({
    userId,
    secret: box.encrypt(userId, IMAP_PASSWORD_CONTEXT, SACHA.password),
    keyId: box.keyId,
  });
  processor = new RuleProcessor({
    config: () => config,
    logger: createLogger({ level: 'silent', format: 'json', name: 'test' }, silent),
    repo,
    account: accountResolver(db.db, box, () => config),
    send,
  });
});

afterAll(async () => {
  await db?.close();
  await Promise.all([pg?.stop(), gm?.stop()]);
});

beforeEach(async () => {
  send.mockClear();
  await db.pool.query('DELETE FROM rules; DELETE FROM auto_replies;');
});

const rule = (input: Partial<RuleInput> & Pick<RuleInput, 'conditions' | 'actions'>) =>
  ruleSchema.parse({ name: 'r', ...input });

async function inbox(): Promise<{ subject: string; flags: string[]; folder: string }[]> {
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapsPort,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: SACHA.email, pass: SACHA.password },
    logger: false,
  });
  await client.connect();
  const out: { subject: string; flags: string[]; folder: string }[] = [];
  try {
    for (const folder of (await client.list()).map((f) => f.path)) {
      const lock = await client.getMailboxLock(folder);
      try {
        if ((client.mailbox && client.mailbox.exists) === 0) continue;
        for await (const msg of client.fetch('1:*', { envelope: true, flags: true })) {
          out.push({ subject: msg.envelope?.subject ?? '', flags: [...(msg.flags ?? [])], folder });
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout();
  }
  return out;
}

const find = async (subject: string) => (await inbox()).find((m) => m.subject === subject);

describe('RuleProcessor', () => {
  it('ne traite pas les messages présents avant la première exécution', async () => {
    await seedMailbox(gm, SACHA, [{ subject: 'Ancien facture', text: 'x' }]);
    await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'facture' }],
        actions: [{ type: 'star' }],
      }),
    );
    expect(await processor.processNew(userId)).toEqual({ processed: 0, matched: 0 });
    expect((await find('Ancien facture'))?.flags).not.toContain('\\Flagged');
  });

  it('applique libellés, lecture et déplacement aux nouveaux messages, une seule fois', async () => {
    const stored = await repo.create(
      userId,
      rule({
        name: 'Factures',
        conditions: [
          { field: 'from', op: 'ends_with', value: '@nimbus.example' },
          { field: 'subject', op: 'contains', value: 'facture' },
        ],
        actions: [
          { type: 'add_label', label: 'Factures' },
          { type: 'mark_read' },
          { type: 'move', folder: 'Archives' },
        ],
        stop_processing: true,
      }),
    );
    await processor.processNew(userId); // positionne le curseur
    await seedMailbox(gm, SACHA, [
      { subject: 'Nouvelle facture', from: 'Nimbus <factures@nimbus.example>', text: 'x' },
      { subject: 'Bonjour', from: 'ami@exemple.fr', text: 'x' },
    ]);
    // Le dossier Archives doit exister (le moteur n'en crée pas pour « move »).
    await seedMailbox(gm, SACHA, [{ folder: 'Archives', subject: 'placeholder', text: 'x' }]);
    const result = await processor.processNew(userId);
    expect(result).toEqual({ processed: 2, matched: 1 });
    const moved = await find('Nouvelle facture');
    expect(moved?.folder).toBe('Archives');
    expect(moved?.flags).toEqual(expect.arrayContaining(['\\Seen', 'Factures']));
    expect((await find('Bonjour'))?.folder).toBe('INBOX');

    // Deuxième passage : rien de nouveau, rien de retraité.
    expect(await processor.processNew(userId)).toEqual({ processed: 0, matched: 0 });
    const stats = (await repo.get(userId, stored.id))?.stats;
    expect(stats?.processedCount).toBe(1);
    expect(stats?.lastRunAt).not.toBeNull();
  });

  it('idempotence : un message déjà réservé n’est jamais retraité (même si le curseur recule)', async () => {
    await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'transfert' }],
        actions: [{ type: 'forward', to: 'alice@exemple.com' }],
      }),
    );
    await processor.processNew(userId);
    await seedMailbox(gm, SACHA, [{ subject: 'Pour transfert', text: 'x' }]);
    await processor.processNew(userId);
    expect(send).toHaveBeenCalledTimes(1);
    // Simule un redémarrage avant la mise à jour du curseur.
    const cursor = await repo.getCursor(userId, 'INBOX');
    await repo.setCursor(userId, 'INBOX', cursor!.uidValidity, cursor!.lastUid - 1);
    await processor.processNew(userId);
    expect(send).toHaveBeenCalledTimes(1);
    const [, envelope, raw] = send.mock.calls[0]!;
    expect(envelope.to).toEqual(['alice@exemple.com']);
    expect(raw.toString()).toContain('X-Plume-Forwarded: 1');
    expect(raw.toString()).toContain('Auto-Submitted: auto-generated');
  });

  it('ne transfère pas vers un domaine devenu interdit ni un message déjà transféré', async () => {
    await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'boucle' }],
        actions: [{ type: 'forward', to: 'alice@exemple.com' }],
      }),
    );
    await processor.processNew(userId);
    await seedMailbox(gm, SACHA, [
      { subject: 'boucle 1', text: 'x', headers: { 'X-Plume-Forwarded': '1' } },
    ]);
    await processor.processNew(userId);
    expect(send).not.toHaveBeenCalled();

    const previous = config;
    config = {
      ...config,
      rules: {
        ...config.rules,
        forward: { enabled: true, allowed_destination_domains: ['autre.example'] },
      },
    };
    await seedMailbox(gm, SACHA, [{ subject: 'boucle 2', text: 'x' }]);
    await processor.processNew(userId);
    config = previous;
    expect(send).not.toHaveBeenCalled();
  });

  it('réponse automatique : une par expéditeur et par 24 h, jamais aux listes ni aux noreply', async () => {
    await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'absence' }],
        actions: [
          { type: 'auto_reply', subject: 'Absent', body: 'Je suis absent <b>jusqu’à lundi</b>.' },
        ],
      }),
    );
    await processor.processNew(userId);
    await seedMailbox(gm, SACHA, [
      { subject: 'absence 1', from: 'client@exemple.fr', text: 'x' },
      { subject: 'absence 2', from: 'client@exemple.fr', text: 'x' },
      {
        subject: 'absence liste',
        from: 'liste@exemple.fr',
        text: 'x',
        headers: { 'List-Id': '<l.exemple.fr>' },
      },
      { subject: 'absence robot', from: 'no-reply@exemple.fr', text: 'x' },
      {
        subject: 'absence auto',
        from: 'autre@exemple.fr',
        text: 'x',
        headers: { 'Auto-Submitted': 'auto-replied' },
      },
    ]);
    await processor.processNew(userId);
    expect(send).toHaveBeenCalledTimes(1);
    const [, envelope, raw] = send.mock.calls[0]!;
    expect(envelope.to).toEqual(['client@exemple.fr']);
    const text = raw.toString().replace(/=\r?\n/g, '');
    expect(text).toContain('Auto-Submitted: auto-replied');
    expect(text).toContain('&lt;b&gt;');
  });

  it('application rétroactive : sans transfert ni réponse automatique', async () => {
    await seedMailbox(gm, SACHA, [{ subject: 'Rétro newsletter', text: 'x' }]);
    const stored = await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'newsletter' }],
        actions: [{ type: 'star' }, { type: 'forward', to: 'alice@exemple.com' }],
      }),
    );
    const progress: [number, number][] = [];
    const result = await processor.applyExisting(userId, stored.id, 'INBOX', async (d, t) => {
      progress.push([d, t]);
    });
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
    expect((await find('Rétro newsletter'))?.flags).toContain('\\Flagged');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignore un compte suspendu', async () => {
    await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'x' }],
        actions: [{ type: 'star' }],
      }),
    );
    await db.pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [userId]);
    await expect(processor.processNew(userId)).rejects.toThrow('account_unavailable');
    await db.pool.query('UPDATE users SET suspended_at = NULL WHERE id = $1', [userId]);
  });
});

async function sachaClient(): Promise<ImapFlow> {
  const client = new ImapFlow(
    imapOptions(
      {
        host: gm.host,
        port: gm.imapsPort,
        security: 'tls',
        tls: { reject_unauthorized: false, min_version: 'TLSv1.2' },
      },
      { user: SACHA.email, pass: SACHA.password },
    ),
  );
  await client.connect();
  return client;
}

async function uidOf(client: ImapFlow, folder: string, subject: string) {
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = (await client.search({ subject }, { uid: true })) || [];
    return {
      folder,
      uidValidity: String(client.mailbox ? client.mailbox.uidValidity : 0),
      uid: Math.max(...uids),
    };
  } finally {
    lock.release();
  }
}

describe('reports et remise dans la boîte', () => {
  it('réveille un message reporté, non lu, dans son dossier d’origine', async () => {
    const snoozes = new SnoozesRepository(db.db);
    await seedMailbox(gm, SACHA, [{ subject: 'Snooze test', text: 'x', flags: ['\\Seen'] }]);
    const client = await sachaClient();
    const moved = await snoozeMessage(client, await uidOf(client, 'INBOX', 'Snooze test'));
    await client.logout();
    expect((await find('Snooze test'))?.folder).toBe('Reportés');
    await snoozes.create(userId, {
      folder: moved.ref!.folder,
      uidValidity: Number(moved.ref!.uidValidity),
      uid: moved.ref!.uid,
      messageId: moved.messageId,
      returnTo: 'INBOX',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);
    const account = accountResolver(db.db, box, () => config);
    // Pas encore l'heure.
    expect(await wakeDueSnoozes({ repo: snoozes, account, logger })).toEqual({
      woken: 0,
      dropped: 0,
      failed: 0,
    });
    const later = () => new Date(Date.now() + 2 * 3_600_000);
    expect(await wakeDueSnoozes({ repo: snoozes, account, logger, now: later })).toEqual({
      woken: 1,
      dropped: 0,
      failed: 0,
    });
    const woken = await find('Snooze test');
    expect(woken?.folder).toBe('INBOX');
    expect(woken?.flags).not.toContain('\\Seen');
    expect(await snoozes.listForUser(userId)).toEqual([]);
  });

  it('clôt un report dont le message a disparu', async () => {
    const snoozes = new SnoozesRepository(db.db);
    await snoozes.create(userId, {
      folder: 'Reportés',
      uidValidity: 1,
      uid: 999_999,
      messageId: '<disparu@exemple.fr>',
      returnTo: 'INBOX',
      wakeAt: new Date(Date.now() - 1000),
    });
    const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);
    const result = await wakeDueSnoozes({
      repo: snoozes,
      account: accountResolver(db.db, box, () => config),
      logger,
    });
    expect(result).toEqual({ woken: 0, dropped: 1, failed: 0 });
  });

  it('ne rejoue pas les règles sur un message remis dans la boîte avec un nouvel UID', async () => {
    await repo.create(
      userId,
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'remis' }],
        actions: [{ type: 'forward', to: 'alice@exemple.com' }],
      }),
    );
    await processor.processNew(userId);
    await seedMailbox(gm, SACHA, [
      { subject: 'Message remis', text: 'x', headers: { 'Message-ID': '<remis@exemple.fr>' } },
    ]);
    await processor.processNew(userId);
    expect(send).toHaveBeenCalledTimes(1);
    // Archivage puis « Annuler » : le message revient avec un nouvel UID.
    const client = await sachaClient();
    await client.mailboxCreate('Archives').catch(() => undefined);
    const ref = await uidOf(client, 'INBOX', 'Message remis');
    const lock = await client.getMailboxLock('INBOX');
    await client.messageMove(String(ref.uid), 'Archives', { uid: true });
    lock.release();
    const back = await uidOf(client, 'Archives', 'Message remis');
    const lock2 = await client.getMailboxLock('Archives');
    await client.messageMove(String(back.uid), 'INBOX', { uid: true });
    lock2.release();
    await client.logout();
    await processor.processNew(userId);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('résumé quotidien', () => {
  it('envoie un résumé par jour, sans contenu de message, et rien si tout est lu', async () => {
    await db.pool.query(
      `INSERT INTO preferences (user_id, notifications) VALUES ($1, '{"desktop":false,"sound":false,"dailyDigest":true}')
       ON CONFLICT (user_id) DO UPDATE SET notifications = EXCLUDED.notifications, last_digest_at = NULL`,
      [userId],
    );
    await seedMailbox(gm, SACHA, [
      {
        subject: 'Digest <b>urgent</b>',
        from: 'Client <client@exemple.fr>',
        text: 'contenu confidentiel',
      },
      { subject: 'Mon propre envoi', from: SACHA.email, text: 'x' },
    ]);
    const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);
    const deps = { db: db.db, account: accountResolver(db.db, box, () => config), logger, send };
    const morning = new Date();
    morning.setHours(8, 0, 0, 0);
    const early = new Date(morning);
    early.setHours(6, 0, 0, 0);

    expect(await sendDueDigests({ ...deps, now: () => early })).toEqual({
      sent: 0,
      empty: 0,
      failed: 0,
    });
    expect(await sendDueDigests({ ...deps, now: () => morning })).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const [, envelope, raw] = send.mock.calls[0]!;
    expect(envelope.to).toEqual([SACHA.email]);
    const text = raw.toString().replace(/=\r?\n/g, '');
    expect(text).toContain('Auto-Submitted: auto-generated');
    expect(text).toContain('Digest &lt;b&gt;urgent&lt;/b&gt;');
    expect(text).not.toContain('contenu confidentiel');
    expect(text).not.toContain('Mon propre envoi');
    // Une seule fois par jour.
    expect(await sendDueDigests({ ...deps, now: () => morning })).toEqual({
      sent: 0,
      empty: 0,
      failed: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('surveillance IMAP IDLE', () => {
  it('signale le rattrapage à la connexion puis chaque arrivée, et s’arrête proprement', async () => {
    const { IdleWatchers } = await import('../src/watcher.js');
    const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);
    const notified: string[] = [];
    const watchers = new IdleWatchers({
      logger,
      account: accountResolver(db.db, box, () => config),
      notify: (user, mailbox) => notified.push(`${user}:${mailbox}`),
      maxConnections: 1,
    });
    watchers.sync([userId, 'ignoré-au-delà-du-plafond']);
    expect(watchers.watching).toEqual([userId]);
    await expect.poll(() => notified.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const before = notified.length;
    await seedMailbox(gm, SACHA, [{ subject: 'Arrivée surveillée', text: 'x' }]);
    await expect.poll(() => notified.length, { timeout: 15_000 }).toBeGreaterThan(before);
    expect(notified.every((n) => n === `${userId}:INBOX`)).toBe(true);
    watchers.sync([]);
    expect(watchers.watching).toEqual([]);
    await watchers.close();
  });

  it('abandonne un compte indisponible', async () => {
    const { IdleWatchers } = await import('../src/watcher.js');
    const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);
    const watchers = new IdleWatchers({
      logger,
      account: async () => null,
      notify: () => undefined,
    });
    watchers.start('inconnu');
    await expect.poll(() => watchers.watching.length, { timeout: 5_000 }).toBe(0);
  });
});
