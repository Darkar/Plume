import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { parseConfig, type PlumeConfig } from '@plume/config';
import { SecretBox } from '@plume/crypto';
import { createDb, migrate, type DbHandle } from '@plume/db';
import { createLogger, createRedis, type Redis } from '@plume/shared';
import { startPostgres, startRedis } from '@plume/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { stringify, parse } from 'yaml';
import { vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createServices, type LoginVerifier, type Services } from '../../src/context.js';
import { UrlSigner } from '../../src/lib/signing.js';
import type { FetchedImage } from '@plume/mail';

export const ORIGIN = 'https://mail.exemple.fr';
export const EXAMPLE_YAML = readFileSync(
  new URL('../../../../config/plume.example.yaml', import.meta.url),
  'utf8',
);

export function testConfig(mutate?: (raw: Record<string, any>) => void): PlumeConfig {
  const raw = parse(EXAMPLE_YAML) as Record<string, any>;
  // Origine fixe des tests, indépendante de la valeur d'exemple.
  raw.server.public_url = ORIGIN;
  mutate?.(raw);
  return parseConfig(stringify(raw));
}

const silent = new Writable({ write: (_c, _e, cb) => cb() });
export const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);

export interface Infra {
  pg: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
  db: DbHandle;
  redis: Redis;
  stop(): Promise<void>;
}

export async function startInfra(): Promise<Infra> {
  const [pg, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
  const db = createDb(pg.getConnectionUri());
  await migrate(db.pool);
  const redis = createRedis(redisContainer.getConnectionUrl());
  return {
    pg,
    redisContainer,
    db,
    redis,
    stop: async () => {
      await db.close();
      redis.disconnect();
      await Promise.all([pg.stop(), redisContainer.stop()]);
    },
  };
}

/** Réinitialise l'état entre deux tests (base et Redis). */
export async function resetInfra(infra: Infra): Promise<void> {
  await infra.redis.flushall();
  await infra.db.pool.query('TRUNCATE users, audit_log RESTART IDENTITY CASCADE');
}

/** Comptes acceptés par le vérificateur factice : adresse → mot de passe. */
export const ACCOUNTS: Record<string, string> = {
  'sacha@exemple.com': 'bon-mot-de-passe',
  'alice@exemple.com': 'mot-de-passe-alice',
  'bob@eu.exemple.fr': 'mot-de-passe-bob',
};

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  verifyLogin: ReturnType<typeof vi.fn<LoginVerifier>>;
  clock: { now: number };
  config: { current: PlumeConfig };
  box: SecretBox;
}

export async function createTestApp(
  infra: Infra,
  options: {
    config?: PlumeConfig;
    verifyLogin?: LoginVerifier;
    fetchImage?: (url: string) => Promise<FetchedImage>;
  } = {},
): Promise<TestApp> {
  const clock = { now: Date.now() };
  const config = { current: options.config ?? testConfig() };
  const verifyLogin = vi.fn<LoginVerifier>(
    options.verifyLogin ??
      (async (_domain, email, password) => (ACCOUNTS[email] === password ? 'ok' : 'invalid')),
  );
  const masterKey = randomBytes(32);
  const box = new SecretBox(masterKey);
  const services = createServices(() => config.current, logger, {
    db: infra.db,
    redis: infra.redis,
    box,
    verifyLogin,
    signer: new UrlSigner(masterKey),
    fetchImage:
      options.fetchImage ??
      (async () => {
        throw new Error('fetchImage non configuré');
      }),
    now: () => clock.now,
    failureDelay: () => 0,
  });
  const app = await buildApp({ config: () => config.current, logger, services });
  return { app, services, verifyLogin, clock, config, box };
}

export interface Client {
  cookie: string | null;
  csrf: string | null;
  request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
}

export const SESSION_COOKIE = '__Host-plume_sid';

/** Client HTTP minimal conservant cookie de session et jeton CSRF, comme le ferait la SPA. */
export function client(app: FastifyInstance): Client {
  const state: Client = {
    cookie: null,
    csrf: null,
    async request(method, url, body, headers = {}) {
      const res = await app.inject({
        method,
        url,
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(state.cookie ? { cookie: `${SESSION_COOKIE}=${state.cookie}` } : {}),
          ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}),
          ...headers,
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      const setCookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
      if (setCookie) state.cookie = setCookie.value === '' ? null : setCookie.value;
      const json = res.headers['content-type']?.includes('json') ? res.json() : null;
      if (json && typeof json.csrfToken === 'string') state.csrf = json.csrfToken;
      return res;
    },
  };
  return state;
}

export async function login(
  c: Client,
  email: string,
  password = ACCOUNTS[email] ?? 'x',
  extra: Record<string, unknown> = {},
) {
  return c.request('POST', '/api/v1/auth/login', { email, password, ...extra });
}
