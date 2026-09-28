import { timeStep, totpAt } from '@plume/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  client,
  createTestApp,
  login,
  ORIGIN,
  resetInfra,
  startInfra,
  testConfig,
  type Infra,
  type TestApp,
} from './support/harness.js';

let infra: Infra;
let t: TestApp;

beforeAll(async () => {
  infra = await startInfra();
});

afterAll(async () => {
  await t?.app.close();
  await infra?.stop();
});

beforeEach(async () => {
  await t?.app.close();
  await resetInfra(infra);
  t = await createTestApp(infra);
});

async function auditEvents() {
  const { rows } = await infra.db.pool.query(
    'SELECT event, subject, metadata::text AS metadata FROM audit_log ORDER BY id',
  );
  return rows as { event: string; subject: string | null; metadata: string }[];
}

describe('connexion', () => {
  it('ouvre une session avec un cookie correctement protégé', async () => {
    const c = client(t.app);
    const res = await login(c, 'sacha@exemple.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', user: { email: 'sacha@exemple.com' } });
    expect(res.json().csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(/^__Host-plume_sid=[A-Za-z0-9_-]{43};/);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toMatch(/Domain=/i);
    expect(header).not.toMatch(/Max-Age|Expires/i); // cookie de session par défaut

    const me = await c.request('GET', '/api/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'sacha@exemple.com', totp: { enabled: false } });
  });

  it('« se souvenir de moi » pose un cookie persistant', async () => {
    const c = client(t.app);
    const res = await login(c, 'sacha@exemple.com', undefined, { remember: true });
    expect(String(res.headers['set-cookie'])).toContain(`Max-Age=${30 * 86400}`);
  });

  it('normalise l’adresse avant de contacter le serveur', async () => {
    const c = client(t.app);
    const res = await login(c, '  Sacha@EXEMPLE.com ', ACCOUNTS['sacha@exemple.com']);
    expect(res.statusCode).toBe(200);
    expect(t.verifyLogin).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'exemple.com' }),
      'sacha@exemple.com',
      ACCOUNTS['sacha@exemple.com'],
    );
  });

  it('accepte un sous-domaine couvert par un joker', async () => {
    const res = await login(client(t.app), 'bob@eu.exemple.fr');
    expect(res.statusCode).toBe(200);
    expect(t.verifyLogin.mock.calls[0]?.[0].domain).toBe('*.exemple.fr');
  });

  it('refuse un mauvais mot de passe avec un message générique', async () => {
    const res = await login(client(t.app), 'sacha@exemple.com', 'mauvais');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('conserve le mot de passe IMAP chiffré, illisible sans la clé maître', async () => {
    await login(client(t.app), 'sacha@exemple.com');
    const { rows } = await infra.db.pool.query('SELECT user_id, secret, key_id FROM credentials');
    expect(rows).toHaveLength(1);
    expect(rows[0].secret).not.toContain(ACCOUNTS['sacha@exemple.com']);
    expect(rows[0].key_id).toBe(t.box.keyId);
    expect(await t.services.users.readImapPassword(rows[0].user_id)).toBe(
      ACCOUNTS['sacha@exemple.com'],
    );
  });

  it("n'écrit jamais le mot de passe dans le journal d'audit", async () => {
    await login(client(t.app), 'sacha@exemple.com');
    await login(client(t.app), 'sacha@exemple.com', 'mot-de-passe-errone');
    const events = await auditEvents();
    expect(events.map((e) => e.event)).toEqual(['login_success', 'login_failure']);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(ACCOUNTS['sacha@exemple.com']);
    expect(dump).not.toContain('mot-de-passe-errone');
  });

  it.each([
    [{}, 'champs manquants'],
    [{ email: 'sacha@exemple.com' }, 'mot de passe manquant'],
    [{ email: 'sacha@exemple.com', password: 'x', admin: true }, 'champ inconnu'],
    [{ email: ['sacha@exemple.com'], password: 'x' }, 'type invalide'],
    [{ email: 'sacha@exemple.com', password: 'x'.repeat(2000) }, 'mot de passe trop long'],
  ] as [unknown, string][])('rejette un corps invalide (%s)', async (body) => {
    const res = await client(t.app).request('POST', '/api/v1/auth/login', body);
    expect(res.statusCode).toBe(400);
    expect(t.verifyLogin).not.toHaveBeenCalled();
  });
});

describe('liste blanche', () => {
  it.each([
    ['user@evil.com', 'domaine non autorisé'],
    ['user@sub.exemple.com', 'sous-domaine non prévu'],
    ['user@exemple.fr', 'domaine de base d’un joker'],
    ['user@evilexemple.fr', 'suffixe sans point'],
    ['user@exemple.com.evil.com', 'domaine autorisé en préfixe'],
    ['user@m\u{430}gnan.one', 'homoglyphe cyrillique'],
    ['user@xn--mgnan-2ve.one', 'punycode d’homoglyphe'],
    ['user@evil.com@exemple.com', 'double arobase'],
    ['user@exemple.com@evil.com', 'double arobase inversée'],
    ['us er@exemple.com', 'espace interne'],
    ['user\u{0}@exemple.com', 'caractère nul'],
    ['user@exemple.com\u{0}', 'caractère nul final'],
    ['user@exemple.com\r\nRCPT TO:<x@evil.com>', 'CRLF'],
    ['user@127.0.0.1', 'adresse IP'],
    ['user@[169.254.169.254]', 'littéral IP'],
    ['user@localhost', 'hôte local'],
    ['', 'vide'],
  ])('refuse %j (%s) sans aucune connexion IMAP', async (email) => {
    const res = await login(client(t.app), email, 'mot-de-passe');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(t.verifyLogin).not.toHaveBeenCalled();
  });

  it('comptes autorisés : un compte absent de la liste est refusé sans connexion IMAP', async () => {
    t.config.current = testConfig((raw) => {
      raw.domains[0].accounts = ['sacha'];
    });
    const denied = await login(client(t.app), 'alice@exemple.com', ACCOUNTS['alice@exemple.com']);
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: 'invalid_credentials' });
    expect(t.verifyLogin).not.toHaveBeenCalled();
    const allowed = await login(client(t.app), 'sacha@exemple.com', ACCOUNTS['sacha@exemple.com']);
    expect(allowed.statusCode).toBe(200);
  });

  it('répond exactement comme pour un mauvais mot de passe', async () => {
    const denied = await login(client(t.app), 'user@evil.com', 'x');
    const wrong = await login(client(t.app), 'sacha@exemple.com', 'x');
    expect(denied.statusCode).toBe(wrong.statusCode);
    expect(denied.body).toBe(wrong.body);
    expect(Object.keys(denied.headers).sort()).toEqual(Object.keys(wrong.headers).sort());
  });

  it('impose une durée minimale aux réponses en échec', async () => {
    await t.app.close();
    t = await createTestApp(infra);
    t.services.failureDelay = () => 150;
    const started = Date.now();
    const res = await login(client(t.app), 'user@evil.com', 'x');
    expect(res.statusCode).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('invalide les sessions quand le domaine est retiré de la liste', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(200);
    t.config.current = testConfig((raw) => {
      raw.domains = raw.domains.filter((d: { domain: string }) => d.domain !== 'exemple.com');
    });
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('suspend les comptes d’un domaine retiré', async () => {
    await login(client(t.app), 'sacha@exemple.com');
    const ids = await t.services.users.suspendDomain('exemple.com');
    expect(ids).toHaveLength(1);
    expect(await t.services.users.activeDomains()).toEqual([]);
  });
});

describe('limitation de débit', () => {
  it('verrouille un compte après trop d’échecs, même avec le bon mot de passe', async () => {
    const c = client(t.app);
    for (let i = 0; i < 5; i++) {
      expect((await login(c, 'sacha@exemple.com', `essai-${i}`)).statusCode).toBe(401);
    }
    const locked = await login(c, 'sacha@exemple.com');
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: 'too_many_attempts' });
    // Le serveur IMAP n'est plus sollicité pendant le verrouillage.
    expect(t.verifyLogin).toHaveBeenCalledTimes(5);
    // Un autre compte n'est pas affecté.
    expect((await login(client(t.app), 'alice@exemple.com')).statusCode).toBe(200);
  });

  it('verrouille aussi une adresse d’un domaine refusé (pas d’oracle sur la liste)', async () => {
    for (let i = 0; i < 5; i++) await login(client(t.app), 'user@evil.com', `x${i}`);
    expect((await login(client(t.app), 'user@evil.com', 'x')).statusCode).toBe(429);
  });

  it('limite les tentatives par adresse IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await login(client(t.app), `user${i}@exemple.com`, 'x');
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("ne compte pas une panne du serveur IMAP comme un échec d'authentification", async () => {
    await t.app.close();
    t = await createTestApp(infra, { verifyLogin: async () => 'unavailable' });
    for (let i = 0; i < 7; i++) await login(client(t.app), `sacha@exemple.com`, 'x', {});
    expect(await t.services.limiter.isLocked('sacha@exemple.com')).toBe(false);
  });
});

describe('sessions', () => {
  it('empêche la fixation de session', async () => {
    const c = client(t.app);
    const planted = 'A'.repeat(43);
    c.cookie = planted;
    await login(c, 'sacha@exemple.com');
    expect(c.cookie).not.toBe(planted);

    // Un identifiant de session valide existant est lui aussi remplacé.
    const before = c.cookie;
    await login(c, 'sacha@exemple.com');
    expect(c.cookie).not.toBe(before);
    const old = client(t.app);
    old.cookie = before;
    expect((await old.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('invalide la session après déconnexion', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const stolen = c.cookie;
    const res = await c.request('POST', '/api/v1/auth/logout');
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    const replay = client(t.app);
    replay.cookie = stolen;
    expect((await replay.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('« déconnecter tous mes appareils » révoque toutes les sessions', async () => {
    const a = client(t.app);
    const b = client(t.app);
    await login(a, 'sacha@exemple.com');
    await login(b, 'sacha@exemple.com');
    const other = client(t.app);
    await login(other, 'alice@exemple.com');
    expect((await a.request('POST', '/api/v1/auth/logout-all')).statusCode).toBe(204);
    expect((await a.request('GET', '/api/v1/me')).statusCode).toBe(401);
    expect((await b.request('GET', '/api/v1/me')).statusCode).toBe(401);
    expect((await other.request('GET', '/api/v1/me')).statusCode).toBe(200);
  });

  it("expire après la période d'inactivité", async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    t.clock.now += 29 * 60_000;
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(200);
    t.clock.now += 29 * 60_000; // actif récemment : toujours valide
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(200);
    t.clock.now += 31 * 60_000;
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('expire après la durée absolue malgré l’activité', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    for (let i = 0; i < 25; i++) {
      t.clock.now += 29 * 60_000;
      await c.request('GET', '/api/v1/me');
    }
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('ne stocke dans Redis que l’empreinte de l’identifiant', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const keys = await infra.redis.keys('plume:sess:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(c.cookie as string);
  });

  it.each(['', 'x', 'A'.repeat(42), 'A'.repeat(200), '../../etc/passwd', 'plume:sess:*'])(
    'ignore un cookie de session mal formé (%j)',
    async (value) => {
      const c = client(t.app);
      c.cookie = value;
      expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(401);
    },
  );
});

describe('CSRF', () => {
  it('refuse une requête authentifiée sans jeton', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    c.csrf = null;
    const res = await c.request('POST', '/api/v1/auth/logout');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invalid_csrf_token' });
  });

  it('refuse un jeton d’une autre session', async () => {
    const a = client(t.app);
    const b = client(t.app);
    await login(a, 'sacha@exemple.com');
    await login(b, 'alice@exemple.com');
    a.csrf = b.csrf;
    expect((await a.request('POST', '/api/v1/auth/logout')).statusCode).toBe(403);
  });

  it.each([
    [{ origin: 'https://evil.example' }, 'origine étrangère'],
    [{ origin: 'null' }, 'origine opaque'],
    [{ origin: '' }, 'origine vide'],
    [{ origin: `${ORIGIN}.evil.example` }, 'origine préfixée'],
    [{ 'sec-fetch-site': 'cross-site' }, 'Sec-Fetch-Site cross-site'],
    [{ 'sec-fetch-site': 'same-site' }, 'Sec-Fetch-Site same-site'],
  ] as [Record<string, string>, string][])('refuse une connexion avec %j (%s)', async (headers) => {
    const res = await client(t.app).request(
      'POST',
      '/api/v1/auth/login',
      { email: 'sacha@exemple.com', password: ACCOUNTS['sacha@exemple.com'] },
      headers,
    );
    expect(res.statusCode).toBe(403);
    expect(t.verifyLogin).not.toHaveBeenCalled();
  });

  it('refuse une requête sans en-tête Origin', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'sacha@exemple.com', password: 'x' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuse un corps text/plain ou formulaire (requête « simple »)', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': type, origin: ORIGIN },
        payload: '{"email":"sacha@exemple.com","password":"bon-mot-de-passe"}',
      });
      expect(res.statusCode).toBe(415);
    }
    expect(t.verifyLogin).not.toHaveBeenCalled();
  });
});

describe('TOTP', () => {
  async function enroll(c: ReturnType<typeof client>) {
    const setup = await c.request('POST', '/api/v1/me/totp/setup');
    expect(setup.statusCode).toBe(200);
    const { secret, uri } = setup.json();
    expect(uri).toContain('otpauth://totp/');
    const enable = await c.request('POST', '/api/v1/me/totp/enable', {
      code: totpAt(secret, timeStep(t.clock.now)),
    });
    expect(enable.statusCode).toBe(200);
    return { secret: secret as string, backupCodes: enable.json().backupCodes as string[] };
  }

  it('exige le second facteur après activation', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const { secret, backupCodes } = await enroll(c);
    expect(backupCodes).toHaveLength(10);

    const c2 = client(t.app);
    const res = await login(c2, 'sacha@exemple.com');
    expect(res.json().status).toBe('totp_required');
    // Session partielle : aucune ressource accessible.
    expect((await c2.request('GET', '/api/v1/me')).statusCode).toBe(401);

    t.clock.now += 30_000;
    const partialCookie = c2.cookie;
    const ok = await c2.request('POST', '/api/v1/auth/totp/verify', {
      code: totpAt(secret, timeStep(t.clock.now)),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ok');
    expect(c2.cookie).not.toBe(partialCookie); // nouvel identifiant après le second facteur
    expect((await c2.request('GET', '/api/v1/me')).json().totp.enabled).toBe(true);
  });

  it('refuse un code TOTP rejoué', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const { secret } = await enroll(c);
    t.clock.now += 30_000;
    const code = totpAt(secret, timeStep(t.clock.now));

    const first = client(t.app);
    await login(first, 'sacha@exemple.com');
    expect((await first.request('POST', '/api/v1/auth/totp/verify', { code })).statusCode).toBe(
      200,
    );

    const replay = client(t.app);
    await login(replay, 'sacha@exemple.com');
    const res = await replay.request('POST', '/api/v1/auth/totp/verify', { code });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_code' });
  });

  it('accepte un code de secours une seule fois', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const { backupCodes } = await enroll(c);
    const code = (backupCodes[0] as string).toUpperCase().replace('-', ' ');

    const a = client(t.app);
    await login(a, 'sacha@exemple.com');
    expect(
      (await a.request('POST', '/api/v1/auth/totp/verify', { backupCode: code })).statusCode,
    ).toBe(200);

    const b = client(t.app);
    await login(b, 'sacha@exemple.com');
    expect(
      (await b.request('POST', '/api/v1/auth/totp/verify', { backupCode: code })).statusCode,
    ).toBe(401);
    const { rows } = await infra.db.pool.query('SELECT code_hash FROM backup_codes');
    expect(JSON.stringify(rows)).not.toContain(backupCodes[1]);
  });

  it('détruit la session partielle après trop de codes erronés', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    await enroll(c);
    const d = client(t.app);
    await login(d, 'sacha@exemple.com');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await d.request('POST', '/api/v1/auth/totp/verify', { code: '000000' })).statusCode,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect(
      (await d.request('POST', '/api/v1/auth/totp/verify', { code: '000000' })).statusCode,
    ).toBe(401);
  });

  it('refuse l’activation avec un mauvais code', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    await c.request('POST', '/api/v1/me/totp/setup');
    const res = await c.request('POST', '/api/v1/me/totp/enable', { code: '123456' });
    expect(res.statusCode).toBe(401);
    expect(await t.services.users.hasTotp((await c.request('GET', '/api/v1/me')).json().id)).toBe(
      false,
    );
  });

  it('stocke le secret TOTP chiffré', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const { secret } = await enroll(c);
    const { rows } = await infra.db.pool.query('SELECT secret FROM totp');
    expect(rows[0].secret).not.toContain(secret);
    const redisDump = JSON.stringify(
      await Promise.all(
        (await infra.redis.keys('*')).map((k) => infra.redis.get(k).catch(() => '')),
      ),
    );
    expect(redisDump).not.toContain(secret);
  });

  it('impose l’enrôlement quand la politique est « required »', async () => {
    await t.app.close();
    t = await createTestApp(infra, {
      config: testConfig((raw) => {
        raw.auth.totp = 'required';
      }),
    });
    const c = client(t.app);
    const res = await login(c, 'sacha@exemple.com');
    expect(res.json().status).toBe('totp_enrollment_required');
    expect((await c.request('POST', '/api/v1/auth/logout-all')).statusCode).toBe(401);
    await enroll(c);
    expect((await c.request('GET', '/api/v1/auth/session')).json().status).toBe('ok');
  });

  it('désactive le TOTP avec un code valide', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const { secret } = await enroll(c);
    t.clock.now += 30_000;
    const res = await c.request('POST', '/api/v1/me/totp/disable', {
      code: totpAt(secret, timeStep(t.clock.now)),
    });
    expect(res.statusCode).toBe(204);
    expect((await login(client(t.app), 'sacha@exemple.com')).json().status).toBe('ok');
  });
});

describe('plusieurs comptes', () => {
  const me = async (c: ReturnType<typeof client>) =>
    (await c.request('GET', '/api/v1/me')).json().email as string;

  it('ajoute un compte, bascule et garde les données de chaque compte séparées', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    await c.request('PATCH', '/api/v1/me/preferences', { theme: 'dark' });
    const before = c.cookie;

    const added = await c.request('POST', '/api/v1/auth/accounts', {
      email: 'alice@exemple.com',
      password: ACCOUNTS['alice@exemple.com'],
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().accounts).toEqual([
      { email: 'alice@exemple.com', active: true },
      { email: 'sacha@exemple.com', active: false },
    ]);
    // Nouvel identifiant de session : l'ancien ne vaut plus rien.
    expect(c.cookie).not.toBe(before);
    const stale = client(t.app);
    stale.cookie = before;
    expect((await stale.request('GET', '/api/v1/me')).statusCode).toBe(401);

    expect(await me(c)).toBe('alice@exemple.com');
    expect((await c.request('GET', '/api/v1/me/preferences')).json().theme).toBe('auto');

    const back = await c.request('POST', '/api/v1/auth/switch', { email: 'sacha@exemple.com' });
    expect(back.statusCode).toBe(200);
    expect(await me(c)).toBe('sacha@exemple.com');
    expect((await c.request('GET', '/api/v1/me/preferences')).json().theme).toBe('dark');
    expect(
      (await c.request('POST', '/api/v1/auth/switch', { email: 'bob@eu.exemple.fr' })).statusCode,
    ).toBe(404);

    const events = (await auditEvents()).map((e) => e.event);
    expect(events).toContain('account_added');
    expect(events).toContain('account_switched');
  });

  it('applique les mêmes contrôles qu’une connexion, sans toucher la session', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    t.verifyLogin.mockClear();
    const wrong = await c.request('POST', '/api/v1/auth/accounts', {
      email: 'alice@exemple.com',
      password: 'faux',
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' });
    const denied = await c.request('POST', '/api/v1/auth/accounts', {
      email: 'user@evil.com@exemple.com',
      password: 'x',
    });
    expect(denied.statusCode).toBe(401);
    expect(t.verifyLogin).toHaveBeenCalledTimes(1);
    expect(await me(c)).toBe('sacha@exemple.com');
    // Exige une session complète et le jeton CSRF.
    expect(
      (
        await client(t.app).request('POST', '/api/v1/auth/accounts', {
          email: 'alice@exemple.com',
          password: ACCOUNTS['alice@exemple.com'],
        })
      ).statusCode,
    ).toBe(401);
    const noCsrf = await c.request(
      'POST',
      '/api/v1/auth/accounts',
      { email: 'alice@exemple.com', password: ACCOUNTS['alice@exemple.com'] },
      { 'x-csrf-token': 'faux' },
    );
    expect(noCsrf.statusCode).toBe(403);
    // Un compte déjà ouvert n'est pas ajouté deux fois.
    expect(
      (
        await c.request('POST', '/api/v1/auth/accounts', {
          email: 'sacha@exemple.com',
          password: ACCOUNTS['sacha@exemple.com'],
        })
      ).statusCode,
    ).toBe(409);
  });

  it('exige le second facteur du compte ajouté', async () => {
    const alice = client(t.app);
    await login(alice, 'alice@exemple.com');
    const setup = await alice.request('POST', '/api/v1/me/totp/setup');
    const secret = setup.json().secret as string;
    await alice.request('POST', '/api/v1/me/totp/enable', {
      code: totpAt(secret, timeStep(t.clock.now)),
    });
    t.clock.now += 60_000;

    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    const added = await c.request('POST', '/api/v1/auth/accounts', {
      email: 'alice@exemple.com',
      password: ACCOUNTS['alice@exemple.com'],
    });
    expect(added.json()).toMatchObject({
      status: 'totp_required',
      pendingAccount: 'alice@exemple.com',
    });
    expect(await me(c)).toBe('sacha@exemple.com');
    expect(
      (await c.request('POST', '/api/v1/auth/accounts/totp', { code: '000000' })).statusCode,
    ).toBe(401);
    const ok = await c.request('POST', '/api/v1/auth/accounts/totp', {
      code: totpAt(secret, timeStep(t.clock.now)),
    });
    expect(ok.statusCode).toBe(200);
    expect(await me(c)).toBe('alice@exemple.com');
  });

  it('ferme un compte, puis le dernier (déconnexion)', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    await c.request('POST', '/api/v1/auth/accounts', {
      email: 'alice@exemple.com',
      password: ACCOUNTS['alice@exemple.com'],
    });
    const removed = await c.request('POST', '/api/v1/auth/accounts/remove', {
      email: 'alice@exemple.com',
    });
    expect(removed.json().accounts).toEqual([{ email: 'sacha@exemple.com', active: true }]);
    expect(await me(c)).toBe('sacha@exemple.com');
    const last = await c.request('POST', '/api/v1/auth/accounts/remove', {
      email: 'sacha@exemple.com',
    });
    expect(last.statusCode).toBe(204);
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('« déconnecter tous mes appareils » d’un compte ferme aussi les sessions où il est ajouté', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    await c.request('POST', '/api/v1/auth/accounts', {
      email: 'alice@exemple.com',
      password: ACCOUNTS['alice@exemple.com'],
    });
    await c.request('POST', '/api/v1/auth/switch', { email: 'sacha@exemple.com' });
    const alice = client(t.app);
    await login(alice, 'alice@exemple.com');
    expect((await alice.request('POST', '/api/v1/auth/logout-all')).statusCode).toBe(204);
    expect((await c.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });

  it('limite le nombre de comptes par session', async () => {
    const c = client(t.app);
    await login(c, 'sacha@exemple.com');
    // Comptes supplémentaires acceptés par le vérificateur de test.
    const extra = ['a1', 'a2', 'a3', 'a4', 'a5'].map((n) => `${n}@exemple.com`);
    t.verifyLogin.mockImplementation(async () => 'ok');
    const codes: number[] = [];
    for (const email of extra) {
      codes.push(
        (await c.request('POST', '/api/v1/auth/accounts', { email, password: 'x' })).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 409]);
  });
});
