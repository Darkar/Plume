import { createServer, type Server } from 'node:http';

export interface HealthState {
  ready: () => Promise<boolean>;
}

/** Petit serveur HTTP interne exposant /healthz et /readyz pour Docker. */
export function createHealthServer(state: HealthState): Server {
  return createServer((req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/readyz') {
      state.ready().then(
        (ok) => send(ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable' }),
        () => send(503, { status: 'unavailable' }),
      );
      return;
    }
    return send(404, { error: 'not_found' });
  });
}
