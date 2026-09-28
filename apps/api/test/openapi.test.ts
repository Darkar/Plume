import { readFileSync } from 'node:fs';
import { parseConfig } from '@plume/config';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { API_ROUTES, buildOpenApi } from '../src/openapi.js';
import { actionRoutes } from '../src/routes/actions.js';
import { authRoutes } from '../src/routes/auth.js';
import { eventRoutes } from '../src/routes/events.js';
import { mailRoutes } from '../src/routes/mail.js';
import { meRoutes } from '../src/routes/me.js';
import { rulesRoutes } from '../src/routes/rules.js';

/** Routes réellement enregistrées par les modules de l'API (sans infrastructure). */
async function registeredRoutes(): Promise<string[]> {
  const app = Fastify();
  // Les routes n'utilisent les services qu'à l'exécution des requêtes.
  const config = parseConfig(
    readFileSync(new URL('../../../config/plume.example.yaml', import.meta.url), 'utf8'),
  );
  const services = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === 'config'
          ? () => config
          : key === 'getter' || key === 'setter'
            ? undefined
            : () => undefined,
    },
  );
  app.decorate('services', services as never);
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push(`${method.toLowerCase()} ${route.url.replace(/:(\w+)/g, '{$1}')}`);
    }
  });
  for (const plugin of [authRoutes, meRoutes, mailRoutes, actionRoutes, rulesRoutes, eventRoutes]) {
    await app.register(plugin);
  }
  await app.ready();
  await app.close();
  return routes.sort();
}

describe('OpenAPI', () => {
  it('décrit exactement les routes enregistrées', async () => {
    const documented = API_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(documented).toEqual(await registeredRoutes());
  });

  it('docs/openapi.json est à jour (pnpm --filter @plume/api openapi)', () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const committed = JSON.parse(
      readFileSync(new URL('../../../docs/openapi.json', import.meta.url), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi(version))));
  });

  it('les schémas de requête proviennent de la validation réelle', () => {
    const spec = buildOpenApi('test');
    const login = spec.paths['/auth/login']!.post as {
      requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } };
      security: unknown[];
    };
    expect(login.security).toEqual([]);
    expect(login.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['email', 'password'],
    });
    const send = spec.paths['/messages/send']!.post as { security: unknown[] };
    expect(send.security).toEqual([{ session: [], csrf: [] }]);
    const list = spec.paths['/messages']!.get as { parameters: { name: string }[] };
    expect(list.parameters.map((p) => p.name)).toContain('folder');
  });
});
