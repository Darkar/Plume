import type { FastifyPluginAsync } from 'fastify';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const healthRoutes: FastifyPluginAsync<{ checks: ReadinessCheck[] }> = async (
  app,
  { checks },
) => {
  // Vivacité : le processus répond. Aucune dépendance externe n'est interrogée.
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Disponibilité : les dépendances (Postgres, Redis…) répondent.
  app.get('/readyz', { logLevel: 'warn' }, async (request, reply) => {
    const results = await Promise.all(
      checks.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return [name, 'ok'] as const;
        } catch (error) {
          request.log.warn({ check: name, err: error }, 'dépendance indisponible');
          return [name, 'error'] as const;
        }
      }),
    );
    const ok = results.every(([, status]) => status === 'ok');
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'unavailable',
      checks: Object.fromEntries(results),
    });
  });
};
