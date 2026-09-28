import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { parseConfig } from '@plume/config';
import { createLogger } from '@plume/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const config = parseConfig(
  readFileSync(new URL('../../../config/plume.example.yaml', import.meta.url), 'utf8'),
);
const silent = new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({ level: 'silent', format: 'json', name: 'test' }, silent);

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('API — socle', () => {
  it('GET /healthz répond ok', async () => {
    app = await buildApp({ config: () => config, logger });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('pose les en-têtes de sécurité', async () => {
    app = await buildApp({ config: () => config, logger });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /readyz renvoie 503 si une dépendance échoue, sans détail', async () => {
    app = await buildApp({
      config: () => config,
      logger,
      readinessChecks: [
        { name: 'postgres', check: async () => undefined },
        {
          name: 'redis',
          check: async () => {
            throw new Error('ECONNREFUSED redis://:motdepasse@redis:6379');
          },
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'ok', redis: 'error' },
    });
    expect(res.body).not.toContain('motdepasse');
  });

  it('GET /readyz renvoie 200 quand tout répond', async () => {
    app = await buildApp({
      config: () => config,
      logger,
      readinessChecks: [{ name: 'postgres', check: async () => undefined }],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });

  it('renvoie un 404 JSON générique', async () => {
    app = await buildApp({ config: () => config, logger });
    const res = await app.inject({ method: 'GET', url: '/../../etc/passwd' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('ne divulgue pas les erreurs internes', async () => {
    app = await buildApp({ config: () => config, logger });
    app.get('/boom', async () => {
      throw new Error('SELECT * FROM secrets WHERE password = hunter2');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('hunter2');
  });

  it('refuse un corps trop volumineux', async () => {
    app = await buildApp({ config: () => config, logger });
    app.post('/echo', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'payload_too_large' });
  });

  it("ignore l'identifiant de requête fourni par le client", async () => {
    app = await buildApp({ config: () => config, logger });
    let seen = '';
    app.get('/id', async (request) => {
      seen = request.id;
      return {};
    });
    await app.inject({ method: 'GET', url: '/id', headers: { 'request-id': 'injected\nvalue' } });
    expect(seen).not.toContain('injected');
  });
});
