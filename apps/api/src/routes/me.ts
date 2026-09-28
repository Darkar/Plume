import { generateTotpSecret, totpUri, verifyTotp } from '@plume/crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, HttpError, notFound } from '../lib/http.js';
import { requireSession } from '../plugins/session.js';
import type { SessionData } from '../services/sessions.js';
import { sessionView } from './auth.js';

export const codeBody = z.strictObject({ code: z.string().max(16) });
const PENDING_CONTEXT = 'totp-pending';

export async function meRoutes(app: FastifyInstance) {
  const services = app.services;

  app.get('/me', { preHandler: requireSession(['full', 'enroll']) }, async (request) => {
    const session = request.session as SessionData;
    const user = await services.users.get(session.userId);
    if (!user) throw notFound();
    const totpEnabled = await services.users.hasTotp(user.id);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      totp: {
        policy: services.config().auth.totp,
        enabled: totpEnabled,
        backupCodesRemaining: totpEnabled ? await services.users.remainingBackupCodes(user.id) : 0,
      },
      csrfToken: session.csrf,
    };
  });

  /** Démarre l'enrôlement TOTP : secret provisoire conservé chiffré dans la session. */
  app.post(
    '/me/totp/setup',
    { preHandler: requireSession(['full', 'enroll']) },
    async (request) => {
      const session = request.session as SessionData;
      if (services.config().auth.totp === 'disabled') throw new HttpError(403, 'totp_disabled');
      if (await services.users.hasTotp(session.userId))
        throw new HttpError(409, 'totp_already_enabled');
      const secret = generateTotpSecret();
      session.pendingTotp = services.box.encrypt(session.userId, PENDING_CONTEXT, secret);
      await services.sessions.update(request.sessionId as string, session);
      return { secret, uri: totpUri(secret, session.email) };
    },
  );

  app.post(
    '/me/totp/enable',
    { preHandler: requireSession(['full', 'enroll']) },
    async (request, reply) => {
      const session = request.session as SessionData;
      const parsed = codeBody.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      if (!session.pendingTotp) throw new HttpError(409, 'totp_setup_required');
      const secret = services.box.decrypt(session.userId, PENDING_CONTEXT, session.pendingTotp);
      const { step } = verifyTotp(secret, parsed.data.code.trim(), { now: services.now() });
      if (step === null) throw new HttpError(401, 'invalid_code');

      const backupCodes = await services.users.enableTotp(session.userId, secret, step);
      await services.audit.record({
        event: 'totp_enabled',
        userId: session.userId,
        ip: request.ip,
      });

      // Les autres sessions de l'utilisateur sont révoquées ; celle-ci est renouvelée (nouvel id).
      await services.sessions.destroyAllForUser(session.userId);
      const auth = services.config().auth;
      const { id, session: next } = await services.sessions.create({
        userId: session.userId,
        email: session.email,
        domain: session.domain,
        stage: 'full',
        remember: session.remember,
        policy: {
          sessionTtl: auth.session_ttl,
          idleTimeout: auth.idle_timeout,
          rememberMeTtl: auth.remember_me_ttl,
        },
      });
      app.startSession(reply, id, next);
      return { ...sessionView(next), backupCodes };
    },
  );

  app.post('/me/totp/disable', { preHandler: requireSession(['full']) }, async (request, reply) => {
    const session = request.session as SessionData;
    if (services.config().auth.totp === 'required') throw new HttpError(403, 'totp_required');
    const parsed = codeBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    const totp = await services.users.getTotp(session.userId);
    if (!totp) throw new HttpError(409, 'totp_not_enabled');
    const { step } = verifyTotp(totp.secret, parsed.data.code.trim(), {
      now: services.now(),
      lastUsedStep: totp.lastUsedStep,
    });
    if (step === null || !(await services.users.consumeTotpStep(session.userId, step))) {
      throw new HttpError(401, 'invalid_code');
    }
    await services.users.disableTotp(session.userId);
    await services.audit.record({ event: 'totp_disabled', userId: session.userId, ip: request.ip });
    return reply.status(204).send();
  });

  app.post('/me/totp/backup-codes', { preHandler: requireSession(['full']) }, async (request) => {
    const session = request.session as SessionData;
    const parsed = codeBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    const totp = await services.users.getTotp(session.userId);
    if (!totp) throw new HttpError(409, 'totp_not_enabled');
    const { step } = verifyTotp(totp.secret, parsed.data.code.trim(), {
      now: services.now(),
      lastUsedStep: totp.lastUsedStep,
    });
    if (step === null || !(await services.users.consumeTotpStep(session.userId, step))) {
      throw new HttpError(401, 'invalid_code');
    }
    const backupCodes = await services.users.regenerateBackupCodes(session.userId);
    await services.audit.record({
      event: 'backup_codes_regenerated',
      userId: session.userId,
      ip: request.ip,
    });
    return { backupCodes };
  });
}
