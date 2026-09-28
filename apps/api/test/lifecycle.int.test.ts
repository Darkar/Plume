import { randomBytes } from 'node:crypto';
import { SecretBox } from '@plume/crypto';
import { loginFor, serverFor, verifyImapLogin } from '@plume/mail';
import { startGreenMail, type StartedGreenMail } from '@plume/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rotateMasterKey } from '../src/rotate-key.js';
import { enforceWhitelist } from '../src/services/whitelist.js';
import {
  ACCOUNTS,
  client,
  createTestApp,
  login,
  resetInfra,
  startInfra,
  testConfig,
  type Infra,
  type TestApp,
} from './support/harness.js';

let infra: Infra;
let t: TestApp | undefined;

beforeAll(async () => {
  infra = await startInfra();
});
afterAll(async () => {
  await t?.app.close();
  await infra?.stop();
});
beforeEach(async () => {
  await t?.app.close();
  t = undefined;
  await resetInfra(infra);
});

describe('retrait d’un domaine de la liste blanche', () => {
  it('suspend les comptes et révoque leurs sessions', async () => {
    t = await createTestApp(infra);
    const sacha = client(t.app);
    const bob = client(t.app);
    await login(sacha, 'sacha@exemple.com');
    await login(bob, 'bob@eu.exemple.fr');

    t.config.current = testConfig((raw) => {
      raw.domains = raw.domains.filter((d: { domain: string }) => d.domain !== '*.exemple.fr');
    });
    const removed = await enforceWhitelist(t.services);
    expect(removed).toEqual([{ domain: 'eu.exemple.fr', accounts: 1 }]);
    expect(await infra.redis.keys('plume:sess:*')).toHaveLength(1);
    expect((await sacha.request('GET', '/api/v1/me')).statusCode).toBe(200);

    const { rows } = await infra.db.pool.query(
      'SELECT email FROM users WHERE suspended_at IS NOT NULL',
    );
    expect(rows).toEqual([{ email: 'bob@eu.exemple.fr' }]);
    // Idempotent.
    expect(await enforceWhitelist(t.services)).toEqual([]);
  });
});

describe('comptes autorisés d’un domaine', () => {
  it('suspend un compte retiré de la liste et ferme ses sessions, sans toucher aux autres', async () => {
    t = await createTestApp(infra);
    const sacha = client(t.app);
    const alice = client(t.app);
    await login(sacha, 'sacha@exemple.com');
    await login(alice, 'alice@exemple.com');

    t.config.current = testConfig((raw) => {
      raw.domains[0].accounts = ['sacha@exemple.com'];
    });
    // Effet immédiat sur les sessions, avant même la suspension.
    expect((await alice.request('GET', '/api/v1/me')).statusCode).toBe(401);
    expect(await enforceWhitelist(t.services)).toEqual([{ domain: 'exemple.com', accounts: 1 }]);
    expect((await sacha.request('GET', '/api/v1/me')).statusCode).toBe(200);
    const { rows } = await infra.db.pool.query(
      'SELECT email FROM users WHERE suspended_at IS NOT NULL',
    );
    expect(rows).toEqual([{ email: 'alice@exemple.com' }]);
    expect(await enforceWhitelist(t.services)).toEqual([]);
  });
});

describe('rotation de la clé maître', () => {
  it('rechiffre tous les secrets, puis seule la nouvelle clé les lit', async () => {
    t = await createTestApp(infra);
    await login(client(t.app), 'sacha@exemple.com');
    await login(client(t.app), 'alice@exemple.com');
    const next = new SecretBox(randomBytes(32));

    const result = await rotateMasterKey(infra.db, t.box, next);
    expect(result).toEqual({ credentials: 2, totp: 0 });

    const { rows } = await infra.db.pool.query('SELECT user_id, secret, key_id FROM credentials');
    for (const row of rows) {
      expect(row.key_id).toBe(next.keyId);
      expect(() => t!.box.decrypt(row.user_id, 'imap-password', row.secret)).toThrow();
      expect(Object.values(ACCOUNTS)).toContain(
        next.decrypt(row.user_id, 'imap-password', row.secret),
      );
    }
  });

  it("n'applique rien si une entrée est illisible (transaction)", async () => {
    t = await createTestApp(infra);
    await login(client(t.app), 'sacha@exemple.com');
    await login(client(t.app), 'alice@exemple.com');
    // Altération d'une entrée : la rotation doit échouer sans rien modifier.
    const { rows: target } = await infra.db.pool.query(
      "SELECT c.user_id, c.secret FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.email = 'alice@exemple.com'",
    );
    const parts = (target[0].secret as string).split('.');
    const tag = Buffer.from(parts[4] as string, 'base64url');
    tag[0] = (tag[0] as number) ^ 0xff;
    parts[4] = tag.toString('base64url');
    await infra.db.pool.query('UPDATE credentials SET secret = $1 WHERE user_id = $2', [
      parts.join('.'),
      target[0].user_id,
    ]);
    const before = (await infra.db.pool.query('SELECT secret FROM credentials ORDER BY user_id'))
      .rows;
    await expect(
      rotateMasterKey(infra.db, t.box, new SecretBox(randomBytes(32))),
    ).rejects.toThrow();
    const after = (await infra.db.pool.query('SELECT secret FROM credentials ORDER BY user_id'))
      .rows;
    expect(after).toEqual(before);
  });

  it('refuse une clé identique', async () => {
    t = await createTestApp(infra);
    await expect(rotateMasterKey(infra.db, t.box, t.box)).rejects.toThrow(/identique/);
  });
});

describe('connexion réelle contre GreenMail', () => {
  let gm: StartedGreenMail;
  beforeAll(async () => {
    gm = await startGreenMail([{ email: 'sacha@exemple.com', password: 'imap-secret' }]);
  });
  afterAll(async () => {
    await gm?.stop();
  });

  it('authentifie par LOGIN IMAP sur le serveur du domaine', async () => {
    const config = testConfig((raw) => {
      raw.domains[0].imap = { host: gm.host, port: gm.imapsPort, security: 'tls' };
      raw.domains[0].tls = { reject_unauthorized: false };
    });
    t = await createTestApp(infra, {
      config,
      verifyLogin: (domain, email, password) =>
        verifyImapLogin(serverFor(domain, 'imap'), loginFor(domain, email), password),
    });
    expect((await login(client(t.app), 'sacha@exemple.com', 'mauvais')).statusCode).toBe(401);
    const c = client(t.app);
    expect((await login(c, 'Sacha@Exemple.com', 'imap-secret')).statusCode).toBe(200);
    expect((await c.request('GET', '/api/v1/me')).json().email).toBe('sacha@exemple.com');
  });
});
