import { matchAccount, normalizeEmail } from '@plume/config';
import { verifyTotp } from '@plume/crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest, HttpError, sleep } from '../lib/http.js';
import { requireSession } from '../plugins/session.js';
import {
  MAX_SECOND_FACTOR_ATTEMPTS,
  MAX_SESSION_ACCOUNTS,
  sessionAccounts,
  type SessionAccount,
  type SessionData,
  type SessionStage,
} from '../services/sessions.js';

export const loginBody = z.strictObject({
  email: z.string().max(320),
  password: z.string().min(1).max(1024),
  remember: z.boolean().optional().default(false),
});

export const accountBody = z.strictObject({ email: z.string().max(320) });

export const totpBody = z.union([
  z.strictObject({ code: z.string().max(16) }),
  z.strictObject({ backupCode: z.string().max(32) }),
]);

const INVALID_CREDENTIALS = new HttpError(401, 'invalid_credentials');
const TOO_MANY_ATTEMPTS = new HttpError(429, 'too_many_attempts');

export function sessionView(session: SessionData) {
  return {
    // Comptes ouverts dans la session (adresses seulement), le compte actif en premier.
    accounts: sessionAccounts(session)
      .map((a) => ({ email: a.email, active: a.userId === session.userId }))
      .sort((a, b) => Number(b.active) - Number(a.active)),
    ...(session.pendingAccount ? { pendingAccount: session.pendingAccount.email } : {}),
    status:
      session.stage === 'full'
        ? 'ok'
        : session.stage === 'totp'
          ? 'totp_required'
          : 'totp_enrollment_required',
    csrfToken: session.csrf,
    user: { email: session.email },
  };
}

export async function authRoutes(app: FastifyInstance) {
  const services = app.services;

  /** Garantit une durée minimale aux réponses en échec (voir ServiceDeps.failureDelay). */
  async function failAfter(startedAt: number, error: HttpError): Promise<never> {
    const remaining = services.failureDelay() - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    throw error;
  }

  async function openSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: { userId: string; email: string; domain: string },
    stage: SessionStage,
    remember: boolean,
  ) {
    // Anti-fixation : toute session existante est détruite, un nouvel identifiant est émis.
    if (request.sessionId) await services.sessions.destroy(request.sessionId);
    const auth = services.config().auth;
    const { id, session } = await services.sessions.create({
      ...user,
      stage,
      remember,
      policy: {
        sessionTtl: auth.session_ttl,
        idleTimeout: auth.idle_timeout,
        rememberMeTtl: auth.remember_me_ttl,
      },
    });
    app.startSession(reply, id, session);
    return session;
  }

  /**
   * Vérifie des identifiants : limites par IP et par compte, liste blanche AVANT toute
   * connexion IMAP, puis authentification IMAP. Commun à la connexion et à l'ajout d'un compte.
   */
  async function checkCredentials(
    request: FastifyRequest,
    body: unknown,
  ): Promise<{
    address: { address: string; domain: string };
    password: string;
    remember: boolean;
  }> {
    const startedAt = Date.now();
    const config = services.config();
    const ip = request.ip;

    const parsed = loginBody.safeParse(body);
    if (!parsed.success) throw badRequest();
    const { password, remember } = parsed.data;

    // 1. Limitation par IP (avant toute autre opération).
    const { per_ip: perIp, per_account: perAccount } = config.auth.rate_limit;
    if (await services.limiter.hit('login-ip', ip, perIp.max, perIp.window)) {
      await services.audit.record({
        event: 'login_failure',
        ip,
        metadata: { reason: 'rate_limited' },
      });
      throw TOO_MANY_ATTEMPTS;
    }

    // 2. Normalisation. Une adresse invalide reçoit la même réponse qu'un mauvais mot de passe.
    const address = normalizeEmail(parsed.data.email);
    if (!address) return failAfter(startedAt, INVALID_CREDENTIALS);

    // 3. Verrouillage du compte (appliqué aussi aux domaines refusés : ne révèle pas la liste).
    if (await services.limiter.isLocked(address.address)) {
      await services.audit.record({
        event: 'login_failure',
        subject: address.address,
        ip,
        metadata: { reason: 'locked' },
      });
      return failAfter(startedAt, TOO_MANY_ATTEMPTS);
    }

    // 4. Liste blanche (domaine et, s'il y a lieu, comptes autorisés) : refus AVANT toute
    // connexion IMAP (anti-SSRF, anti-relais), avec la même réponse qu'un mauvais mot de passe.
    const domain = matchAccount(config.domains, address.address);
    let result: 'ok' | 'invalid' | 'unavailable' | 'denied';
    if (!domain) {
      result = 'denied';
    } else {
      result = await services.verifyLogin(domain, address.address, password);
    }

    if (result !== 'ok') {
      // Une panne du serveur n'est pas comptée comme une tentative de force brute.
      const locked =
        result === 'unavailable'
          ? false
          : await services.limiter.recordFailure(address.address, perAccount);
      await services.audit.record({
        event: 'login_failure',
        subject: address.address,
        ip,
        metadata: { reason: result, locked },
      });
      if (result === 'unavailable') {
        request.log.warn({ domain: address.domain }, 'serveur IMAP indisponible');
      }
      return failAfter(startedAt, INVALID_CREDENTIALS);
    }
    await services.limiter.reset(address.address);
    return { address, password, remember };
  }

  /** Code TOTP (anti-rejeu) ou code de secours à usage unique. */
  async function verifySecondFactor(
    userId: string,
    input: z.infer<typeof totpBody>,
  ): Promise<{ ok: boolean; method: 'totp' | 'backup_code' }> {
    if ('code' in input) {
      const totp = await services.users.getTotp(userId);
      if (!totp) return { ok: false, method: 'totp' };
      const { step } = verifyTotp(totp.secret, input.code.trim(), {
        now: services.now(),
        lastUsedStep: totp.lastUsedStep,
      });
      return {
        ok: step !== null && (await services.users.consumeTotpStep(userId, step)),
        method: 'totp',
      };
    }
    return {
      ok: await services.users.useBackupCode(userId, input.backupCode),
      method: 'backup_code',
    };
  }

  app.post('/auth/login', async (request, reply) => {
    const config = services.config();
    const ip = request.ip;
    const { address, password, remember } = await checkCredentials(request, request.body);

    // 5. Succès IMAP.
    const user = await services.users.recordLogin(address.address, address.domain);
    await services.users.storeImapPassword(user.id, password);

    const totpPolicy = config.auth.totp;
    const hasTotp = totpPolicy !== 'disabled' && (await services.users.hasTotp(user.id));
    const stage: SessionStage = hasTotp ? 'totp' : totpPolicy === 'required' ? 'enroll' : 'full';
    const session = await openSession(
      request,
      reply,
      { userId: user.id, email: user.email, domain: user.domain },
      stage,
      remember,
    );
    await services.audit.record({
      event: 'login_success',
      userId: user.id,
      subject: user.email,
      ip,
      metadata: { stage, remember },
    });
    return sessionView(session);
  });

  app.post(
    '/auth/totp/verify',
    { preHandler: requireSession(['totp']) },
    async (request, reply) => {
      const session = request.session as SessionData;
      const sessionId = request.sessionId as string;
      const parsed = totpBody.safeParse(request.body);
      if (!parsed.success) throw badRequest();

      const { ok, method } = await verifySecondFactor(session.userId, parsed.data);

      if (!ok) {
        session.attemptsLeft -= 1;
        await services.audit.record({
          event: 'totp_failure',
          userId: session.userId,
          ip: request.ip,
          metadata: { method, attemptsLeft: session.attemptsLeft },
        });
        if (session.attemptsLeft <= 0) {
          await services.sessions.destroy(sessionId);
          app.clearSession(reply);
          throw TOO_MANY_ATTEMPTS;
        }
        await services.sessions.update(sessionId, session);
        throw new HttpError(401, 'invalid_code');
      }

      const full = await openSession(
        request,
        reply,
        { userId: session.userId, email: session.email, domain: session.domain },
        'full',
        session.remember,
      );
      await services.audit.record({
        event: method === 'totp' ? 'totp_success' : 'backup_code_used',
        userId: session.userId,
        ip: request.ip,
      });
      return sessionView(full);
    },
  );

  app.get(
    '/auth/session',
    { preHandler: requireSession(['full', 'totp', 'enroll']) },
    async (request) => sessionView(request.session as SessionData),
  );

  app.post(
    '/auth/logout',
    { preHandler: requireSession(['full', 'totp', 'enroll']) },
    async (request, reply) => {
      const session = request.session as SessionData;
      await services.sessions.destroy(request.sessionId as string);
      app.clearSession(reply);
      await services.audit.record({ event: 'logout', userId: session.userId, ip: request.ip });
      return reply.status(204).send();
    },
  );

  // ---------- Plusieurs comptes dans une session ----------

  const PENDING_TTL_MS = 5 * 60_000;

  /** Rend `account` actif et le range dans la liste ; nouvel identifiant de session. */
  async function activate(
    request: FastifyRequest,
    reply: FastifyReply,
    session: SessionData,
    account: SessionAccount,
  ) {
    const accounts = sessionAccounts(session).filter((a) => a.userId !== account.userId);
    session.accounts = [...accounts, account];
    session.userId = account.userId;
    session.email = account.email;
    session.domain = account.domain;
    delete session.pendingAccount;
    const id = await services.sessions.rotate(request.sessionId as string, session);
    app.startSession(reply, id, session);
  }

  /**
   * Ajoute un compte à la session courante, avec les mêmes contrôles qu'une connexion. Si ce
   * compte a un second facteur, il n'est ajouté qu'après sa vérification.
   */
  app.post('/auth/accounts', { preHandler: requireSession(['full']) }, async (request, reply) => {
    const session = request.session as SessionData;
    const { address, password } = await checkCredentials(request, request.body);
    const accounts = sessionAccounts(session);
    if (accounts.some((a) => a.email === address.address)) {
      throw new HttpError(409, 'account_already_open');
    }
    if (accounts.length >= MAX_SESSION_ACCOUNTS) throw new HttpError(409, 'too_many_accounts');

    const user = await services.users.recordLogin(address.address, address.domain);
    await services.users.storeImapPassword(user.id, password);
    const account = { userId: user.id, email: user.email, domain: user.domain };
    const totpPolicy = services.config().auth.totp;
    const hasTotp = totpPolicy !== 'disabled' && (await services.users.hasTotp(user.id));
    if (!hasTotp && totpPolicy === 'required') {
      // L'enrôlement se fait lors d'une connexion directe à ce compte.
      throw new HttpError(403, 'totp_enrollment_required');
    }
    await services.audit.record({
      event: 'login_success',
      userId: user.id,
      subject: user.email,
      ip: request.ip,
      metadata: { stage: hasTotp ? 'totp' : 'full', addedTo: session.userId },
    });
    if (hasTotp) {
      session.pendingAccount = {
        ...account,
        attemptsLeft: MAX_SECOND_FACTOR_ATTEMPTS,
        expiresAt: services.now() + PENDING_TTL_MS,
      };
      await services.sessions.update(request.sessionId as string, session);
      return { ...sessionView(session), status: 'totp_required' };
    }
    await activate(request, reply, session, account);
    await services.audit.record({ event: 'account_added', userId: user.id, ip: request.ip });
    return sessionView(session);
  });

  /** Second facteur du compte en cours d'ajout. */
  app.post(
    '/auth/accounts/totp',
    { preHandler: requireSession(['full']) },
    async (request, reply) => {
      const session = request.session as SessionData;
      const pending = session.pendingAccount;
      if (!pending || services.now() > pending.expiresAt) {
        delete session.pendingAccount;
        await services.sessions.update(request.sessionId as string, session);
        throw new HttpError(409, 'no_pending_account');
      }
      const parsed = totpBody.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      const { ok, method } = await verifySecondFactor(pending.userId, parsed.data);
      if (!ok) {
        pending.attemptsLeft -= 1;
        await services.audit.record({
          event: 'totp_failure',
          userId: pending.userId,
          ip: request.ip,
          metadata: { method, attemptsLeft: pending.attemptsLeft, adding: true },
        });
        if (pending.attemptsLeft <= 0) {
          delete session.pendingAccount;
          await services.sessions.update(request.sessionId as string, session);
          throw TOO_MANY_ATTEMPTS;
        }
        await services.sessions.update(request.sessionId as string, session);
        throw new HttpError(401, 'invalid_code');
      }
      const account = { userId: pending.userId, email: pending.email, domain: pending.domain };
      await activate(request, reply, session, account);
      await services.audit.record({
        event: method === 'totp' ? 'totp_success' : 'backup_code_used',
        userId: account.userId,
        ip: request.ip,
      });
      await services.audit.record({
        event: 'account_added',
        userId: account.userId,
        ip: request.ip,
      });
      return sessionView(session);
    },
  );

  /** Abandonne l'ajout d'un compte en attente de son second facteur. */
  app.post(
    '/auth/accounts/cancel',
    { preHandler: requireSession(['full']) },
    async (request, reply) => {
      const session = request.session as SessionData;
      delete session.pendingAccount;
      await services.sessions.update(request.sessionId as string, session);
      return reply.status(204).send();
    },
  );

  /** Bascule vers un autre compte déjà ouvert dans la session. */
  app.post('/auth/switch', { preHandler: requireSession(['full']) }, async (request, reply) => {
    const session = request.session as SessionData;
    const parsed = accountBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    const target = sessionAccounts(session).find((a) => a.email === parsed.data.email);
    if (!target) throw new HttpError(404, 'not_found');
    const from = session.userId;
    await activate(request, reply, session, target);
    await services.audit.record({
      event: 'account_switched',
      userId: target.userId,
      ip: request.ip,
      metadata: { from },
    });
    return sessionView(session);
  });

  /** Ferme un compte de la session ; fermer le dernier revient à se déconnecter. */
  app.post(
    '/auth/accounts/remove',
    { preHandler: requireSession(['full']) },
    async (request, reply) => {
      const session = request.session as SessionData;
      const sessionId = request.sessionId as string;
      const parsed = accountBody.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      const accounts = sessionAccounts(session);
      const target = accounts.find((a) => a.email === parsed.data.email);
      if (!target) throw new HttpError(404, 'not_found');
      await services.audit.record({
        event: 'account_removed',
        userId: target.userId,
        ip: request.ip,
      });
      const rest = accounts.filter((a) => a.userId !== target.userId);
      if (rest.length === 0) {
        await services.sessions.destroy(sessionId);
        app.clearSession(reply);
        return reply.status(204).send();
      }
      session.accounts = rest;
      if (session.userId === target.userId) {
        const next = rest[rest.length - 1]!;
        session.userId = next.userId;
        session.email = next.email;
        session.domain = next.domain;
      }
      await services.sessions.unindex(sessionId, target.userId);
      await services.sessions.update(sessionId, session);
      return sessionView(session);
    },
  );

  app.post('/auth/logout-all', { preHandler: requireSession(['full']) }, async (request, reply) => {
    const session = request.session as SessionData;
    const count = await services.sessions.destroyAllForUser(session.userId);
    app.clearSession(reply);
    await services.audit.record({
      event: 'logout_all',
      userId: session.userId,
      ip: request.ip,
      metadata: { sessions: count },
    });
    return reply.status(204).send();
  });
}
