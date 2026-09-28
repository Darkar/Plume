import cookie from '@fastify/cookie';
import { matchAccount } from '@plume/config';
import { safeEqual } from '@plume/crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Services } from '../context.js';
import { forbidden, unauthorized } from '../lib/http.js';
import type { SessionData, SessionStage } from '../services/sessions.js';

export const SESSION_COOKIE = '__Host-plume_sid';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionData | null;
    sessionId: string | null;
  }
  interface FastifyInstance {
    services: Services;
    startSession(reply: FastifyReply, id: string, session: SessionData): void;
    clearSession(reply: FastifyReply): void;
  }
}

/** Options de route : étapes de session acceptées (par défaut, session complète uniquement). */
export interface AuthRouteOptions {
  stages?: SessionStage[];
}

/**
 * Sessions, cookies et protections CSRF :
 * - vérification de l'origine (en-têtes Origin / Sec-Fetch-Site) pour toute requête modifiant
 *   l'état, authentifiée ou non (protège aussi la connexion) ;
 * - jeton synchronisé (en-tête X-CSRF-Token) comparé à celui de la session.
 */
async function sessionPlugin(app: FastifyInstance, { services }: { services: Services }) {
  app.decorate('services', services);
  await app.register(cookie, { hook: 'onRequest' });
  app.decorateRequest('session', null);
  app.decorateRequest('sessionId', null);

  app.decorate('startSession', (reply: FastifyReply, id: string, session: SessionData) => {
    reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      // Cookie de session (sans date) sauf « se souvenir de moi ».
      ...(session.remember
        ? { maxAge: Math.floor((session.absoluteExpiresAt - session.createdAt) / 1000) }
        : {}),
    });
  });

  app.decorate('clearSession', (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    });
  });

  app.addHook('onRequest', async (request) => {
    if (!SAFE_METHODS.has(request.method)) {
      const expected = services.config().server.public_url;
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        request.log.warn({ fetchSite, origin }, 'requête refusée : appel inter-sites');
        throw forbidden('invalid_origin');
      }
      if (origin !== expected) {
        // Cause la plus fréquente : server.public_url ne correspond pas à l'adresse utilisée dans
        // le navigateur (schéma, nom ou port).
        request.log.warn(
          { origin: origin ?? null, expected },
          'requête refusée : origine différente de server.public_url',
        );
        throw forbidden('invalid_origin');
      }
    }

    const id = request.cookies[SESSION_COOKIE];
    if (!id) return;
    const session = await services.sessions.touch(id);
    if (!session) return;
    // Défense en profondeur : un domaine ou un compte retiré de la liste blanche invalide
    // immédiatement la session.
    const domains = services.config().domains;
    if (!matchAccount(domains, session.email)) {
      await services.sessions.destroy(id);
      return;
    }
    // Idem pour les autres comptes ouverts dans la session : ils en sont retirés.
    if (session.accounts?.some((a) => !matchAccount(domains, a.email))) {
      session.accounts = session.accounts.filter((a) => matchAccount(domains, a.email));
      await services.sessions.update(id, session);
    }
    request.session = session;
    request.sessionId = id;
  });
}

export default fp(sessionPlugin, { name: 'plume-session' });

/** preHandler : exige une session à l'étape voulue et, pour les méthodes non sûres, le jeton CSRF. */
export function requireSession(stages: SessionStage[] = ['full']) {
  return async (request: FastifyRequest) => {
    const session = request.session;
    if (!session || !stages.includes(session.stage)) throw unauthorized();
    if (!SAFE_METHODS.has(request.method)) {
      const token = request.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, session.csrf)) {
        throw forbidden('invalid_csrf_token');
      }
    }
  };
}
