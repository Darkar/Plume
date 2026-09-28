import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer } from '../src/health.js';

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(ready: () => Promise<boolean>) {
  const server = createHealthServer({ ready });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('serveur de santé du worker', () => {
  it('répond à /healthz', async () => {
    const base = await start(async () => true);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  it('renvoie 503 sur /readyz si une dépendance échoue', async () => {
    const base = await start(async () => {
      throw new Error('down');
    });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
  });

  it('refuse les autres méthodes et chemins', async () => {
    const base = await start(async () => true);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/autre`)).status).toBe(404);
  });
});
