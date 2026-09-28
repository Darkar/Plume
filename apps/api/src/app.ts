import helmet from '@fastify/helmet';
import type { PlumeConfig } from '@plume/config';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Logger } from 'pino';
import type { Services } from './context.js';
import { HttpError } from './lib/http.js';
import sessionPlugin from './plugins/session.js';
import { actionRoutes } from './routes/actions.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { mailRoutes } from './routes/mail.js';
import { meRoutes } from './routes/me.js';
import { rulesRoutes } from './routes/rules.js';

export interface AppDeps {
  config: () => PlumeConfig;
  logger: Logger;
  readinessChecks?: ReadinessCheck[];
  /** Services métier ; absents, seules les sondes de santé sont exposées (tests du socle). */
  services?: Services;
}

/** Limite par défaut du corps des requêtes JSON (les pièces jointes ont leurs propres routes). */
const BODY_LIMIT = 1024 * 1024;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const config = deps.config();
  const options: FastifyServerOptions = {
    loggerInstance: deps.logger,
    trustProxy: config.server.trusted_proxies.length > 0 ? config.server.trusted_proxies : false,
    bodyLimit: BODY_LIMIT,
    // Identifiant de requête généré côté serveur ; on ignore celui éventuellement fourni par le client.
    requestIdHeader: false,
    return503OnClosing: true,
    routerOptions: {
      maxParamLength: 200,
    },
  };
  const app = Fastify(options);

  await app.register(helmet, {
    // L'API ne renvoie que du JSON : aucune ressource ne doit pouvoir être chargée.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    );
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  // Seul le JSON est accepté : un formulaire ou du texte brut (requêtes « simples » cross-site,
  // sans pré-vérification CORS) ne peut pas atteindre les routes.
  app.removeContentTypeParser('text/plain');

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.code, ...(error.details ?? {}) });
    }
    const err = error as { statusCode?: number; validation?: unknown; code?: string };
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'erreur interne');
      return reply.status(status).send({ error: 'internal_error' });
    }
    if (err.validation) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    // Pour les erreurs 4xx, on renvoie un code générique sans détail interne.
    const code =
      status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : 'bad_request';
    return reply.status(status).send({ error: status === 404 ? 'not_found' : code });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: 'not_found' });
  });

  await app.register(healthRoutes, { checks: deps.readinessChecks ?? [] });
  if (deps.services) {
    const { mail, rulesQueue } = deps.services;
    app.addHook('onClose', async () => {
      await mail.pool.close();
      await rulesQueue.close();
    });
  }

  if (deps.services) {
    const services = deps.services;
    await app.register(
      async (api) => {
        await api.register(sessionPlugin, { services });
        await api.register(authRoutes);
        await api.register(meRoutes);
        await api.register(mailRoutes);
        await api.register(actionRoutes);
        await api.register(rulesRoutes);
        await api.register(eventRoutes);
      },
      { prefix: '/api/v1' },
    );
  }

  return app;
}
