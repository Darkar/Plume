import {
  ActionError,
  appendSent,
  archiveMessage,
  junkMessage,
  buildMime,
  deleteMessage,
  getReplyInfo,
  isValidRecipient,
  moveMessage,
  sendRaw,
  snoozeMessage,
  wakeMessage,
  updateFlags,
  type MessageRef,
} from '@plume/mail';
import { ConfigError } from '@plume/config';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decodeMessageId, encodeMessageId } from '../lib/ids.js';
import { badRequest, HttpError, notFound } from '../lib/http.js';
import { requireSession } from '../plugins/session.js';
import { AVATAR_MAX_INPUT, AvatarError, reencodeAvatar } from '../lib/avatar.js';
import { preferencesPatch } from '../services/preferences.js';
import type { SessionData } from '../services/sessions.js';
import { invalidateLabels, mapMailError } from './mail.js';

const MAX_RECIPIENTS = 100;
/** Limite d'envoi par utilisateur (anti-abus d'un compte compromis). */
const SEND_LIMIT = { max: 200, windowMs: 60 * 60_000 };

export const flagsBody = z
  .strictObject({
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
    labels: z
      .strictObject({
        add: z.array(z.string().max(64)).max(20).optional(),
        remove: z.array(z.string().max(64)).max(20).optional(),
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

export const avatarBody = z.strictObject({
  data: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export const moveBody = z.strictObject({ folder: z.string().min(1).max(500) });
export const snoozeBody = z.strictObject({ until: z.iso.datetime({ offset: true }) });
const snoozeIdParam = z.strictObject({ id: z.string().uuid() });
/** Un report doit être d'au moins une minute et d'au plus un an. */
const SNOOZE_MIN_MS = 60_000;
const SNOOZE_MAX_MS = 366 * 24 * 3_600_000;

const recipient = z.strictObject({
  name: z.string().max(200).optional().default(''),
  address: z.string().trim().toLowerCase().max(254).refine(isValidRecipient, 'adresse invalide'),
});

export const sendBody = z.strictObject({
  to: z.array(recipient).max(MAX_RECIPIENTS).default([]),
  cc: z.array(recipient).max(MAX_RECIPIENTS).default([]),
  bcc: z.array(recipient).max(MAX_RECIPIENTS).default([]),
  subject: z.string().max(998).default(''),
  html: z
    .string()
    .max(2 * 1024 * 1024)
    .default(''),
  /** Identifiant (opaque) du message auquel on répond : les en-têtes sont lus sur le serveur. */
  inReplyTo: z.string().max(1500).optional(),
  attachments: z
    .array(
      z.strictObject({
        filename: z.string().min(1).max(255),
        contentType: z.string().max(127).default('application/octet-stream'),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
      }),
    )
    .max(20)
    .default([]),
});

export async function actionRoutes(app: FastifyInstance) {
  const services = app.services;
  const auth = { preHandler: requireSession(['full']) };

  function refOf(request: FastifyRequest): MessageRef {
    const ref = decodeMessageId((request.params as { id: string }).id);
    if (!ref) throw notFound();
    return ref;
  }

  async function withClient<T>(
    userId: string,
    fn: (client: Awaited<ReturnType<typeof services.mail.pool.acquire>>) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(await services.mail.pool.acquire(userId));
    } catch (error) {
      if (error instanceof ActionError) {
        throw new HttpError(error.code === 'invalid_folder' ? 404 : 400, error.code);
      }
      return mapMailError(services, userId, error);
    }
  }

  app.patch('/messages/:id', auth, async (request, reply) => {
    const session = request.session as SessionData;
    const ref = refOf(request);
    const parsed = flagsBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    const { seen, flagged, labels } = parsed.data;
    await withClient(session.userId, (client) =>
      updateFlags(client, ref, {
        seen,
        flagged,
        addLabels: labels?.add,
        removeLabels: labels?.remove,
      }),
    );
    if (labels) invalidateLabels(session.userId);
    return reply.status(204).send();
  });

  app.post('/messages/:id/move', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = refOf(request);
    const parsed = moveBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    const moved = await withClient(session.userId, (client) =>
      moveMessage(client, ref, parsed.data.folder),
    );
    return {
      id: moved ? encodeMessageId(moved) : null,
      folder: parsed.data.folder,
      from: ref.folder,
    };
  });

  /** Archive ; la réponse contient le nouvel identifiant pour « Annuler ». */
  app.post('/messages/:id/archive', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = refOf(request);
    const moved = await withClient(session.userId, (client) => archiveMessage(client, ref));
    return {
      id: moved ? encodeMessageId(moved) : null,
      folder: moved?.folder ?? null,
      from: ref.folder,
    };
  });

  /** Signale comme indésirable (dossier « \\Junk ») ; même réponse que l'archivage. */
  app.post('/messages/:id/junk', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = refOf(request);
    const moved = await withClient(session.userId, (client) => junkMessage(client, ref));
    return {
      id: moved ? encodeMessageId(moved) : null,
      folder: moved?.folder ?? null,
      from: ref.folder,
    };
  });

  /** Reporte un message : il quitte la boîte et revient, non lu, à l'échéance. */
  app.post('/messages/:id/snooze', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = refOf(request);
    const parsed = snoozeBody.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    const wakeAt = new Date(parsed.data.until);
    const delay = wakeAt.getTime() - services.now();
    if (delay < SNOOZE_MIN_MS || delay > SNOOZE_MAX_MS) throw badRequest('invalid_snooze_date');
    const moved = await withClient(session.userId, (client) => snoozeMessage(client, ref));
    if (!moved.ref) throw new HttpError(503, 'imap_unavailable');
    const snooze = await services.snoozes.create(session.userId, {
      folder: moved.ref.folder,
      uidValidity: Number(moved.ref.uidValidity),
      uid: moved.ref.uid,
      messageId: moved.messageId,
      returnTo: ref.folder,
      wakeAt,
    });
    return {
      id: encodeMessageId(moved.ref),
      snoozeId: snooze.id,
      from: ref.folder,
      wakeAt: wakeAt.toISOString(),
    };
  });

  /** Reports en cours (affichage de l'échéance dans le dossier « Reportés »). */
  app.get('/snoozes', auth, async (request) => {
    const session = request.session as SessionData;
    const rows = await services.snoozes.listForUser(session.userId);
    return {
      snoozes: rows.map((r) => ({
        id: r.id,
        messageId: encodeMessageId({
          folder: r.folder,
          uidValidity: String(r.uidValidity),
          uid: r.uid,
        }),
        wakeAt: r.wakeAt.toISOString(),
        returnTo: r.returnTo,
      })),
    };
  });

  /** Annule un report : le message revient tout de suite dans son dossier d'origine. */
  app.delete('/snoozes/:id', auth, async (request, reply) => {
    const session = request.session as SessionData;
    const parsed = snoozeIdParam.safeParse(request.params);
    if (!parsed.success) throw notFound();
    const rows = await services.snoozes.listForUser(session.userId);
    const snooze = rows.find((r) => r.id === parsed.data.id);
    if (!snooze) throw notFound();
    await withClient(session.userId, (client) =>
      wakeMessage(
        client,
        {
          folder: snooze.folder,
          uidValidity: String(snooze.uidValidity),
          uid: snooze.uid,
          messageId: snooze.messageId,
          returnTo: snooze.returnTo,
        },
        { markUnseen: false },
      ),
    );
    await services.snoozes.remove(session.userId, snooze.id);
    return reply.status(204).send();
  });

  app.delete('/messages/:id', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = refOf(request);
    const result = await withClient(session.userId, (client) => deleteMessage(client, ref));
    return {
      permanent: result.permanent,
      id: result.ref ? encodeMessageId(result.ref) : null,
      from: ref.folder,
    };
  });

  app.post(
    '/messages/send',
    {
      ...auth,
      // Pièces jointes en base64 dans le JSON (+33 %) : limite propre à cette route.
      bodyLimit: Math.ceil((services.config().security.max_upload_total * 4) / 3) + 3 * 1024 * 1024,
    },
    async (request) => {
      const session = request.session as SessionData;
      const parsed = sendBody.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      const body = parsed.data;
      const recipients = [...body.to, ...body.cc, ...body.bcc];
      if (recipients.length === 0) throw badRequest('no_recipient');
      if (recipients.length > MAX_RECIPIENTS) throw badRequest('too_many_recipients');

      const limits = services.config().security;
      const attachments = body.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.data, 'base64'),
      }));
      if (attachments.some((a) => a.content.length > limits.max_attachment_size)) {
        throw new HttpError(413, 'attachment_too_large');
      }
      if (attachments.reduce((sum, a) => sum + a.content.length, 0) > limits.max_upload_total) {
        throw new HttpError(413, 'attachments_too_large');
      }
      if (await services.limiter.hit('send', session.userId, SEND_LIMIT.max, SEND_LIMIT.windowMs)) {
        throw new HttpError(429, 'rate_limited');
      }

      const replyRef = body.inReplyTo ? decodeMessageId(body.inReplyTo) : null;
      if (body.inReplyTo && !replyRef) throw badRequest('invalid_reply');

      let relay = false;
      try {
        const smtp = await services.mail.smtpCredentials(session.userId);
        relay = smtp.relay;
        const prefs = await services.preferences.get(session.userId);
        const client = replyRef ? await services.mail.pool.acquire(session.userId) : null;
        const replyInfo = replyRef && client ? await getReplyInfo(client, replyRef) : null;
        const references = replyInfo
          ? [...replyInfo.references, ...(replyInfo.messageId ? [replyInfo.messageId] : [])].slice(
              -20,
            )
          : undefined;

        const raw = await buildMime({
          // L'expéditeur est toujours l'adresse du compte connecté.
          from: { name: prefs.displayName ?? '', address: smtp.from },
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          html: body.html,
          inReplyTo: replyInfo?.messageId ?? undefined,
          references,
          attachments,
        });
        await sendRaw(smtp, { from: smtp.from, to: recipients.map((r) => r.address) }, raw);

        // Copie dans « Envoyés » et marque l'original comme répondu : sans effet sur l'envoi en cas d'échec.
        try {
          const imap = client ?? (await services.mail.pool.acquire(session.userId));
          await appendSent(imap, raw);
          if (replyRef) await updateFlags(imap, replyRef, { answered: true });
        } catch (error) {
          request.log.warn({ err: error }, 'copie dans « Envoyés » impossible');
        }
        return { status: 'sent' };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof ConfigError) {
          // Secret du relais SMTP du domaine illisible : erreur d'exploitation.
          request.log.error({ err: error }, 'secret du relais SMTP illisible');
          throw new HttpError(503, 'smtp_unavailable');
        }
        const err = error as { code?: string; responseCode?: number };
        if (err.code === 'EAUTH') {
          // Relais commun refusé : identifiants de l'administrateur, pas ceux de l'utilisateur.
          if (!relay) throw new HttpError(401, 'smtp_auth_failed');
          request.log.error('authentification refusée par le relais SMTP du domaine');
          throw new HttpError(503, 'smtp_unavailable');
        }
        if (
          err.code === 'EENVELOPE' ||
          (err.responseCode !== undefined && err.responseCode >= 500)
        ) {
          throw new HttpError(422, 'recipient_rejected');
        }
        if (
          err.code &&
          ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS'].includes(err.code)
        ) {
          throw new HttpError(503, 'smtp_unavailable');
        }
        return mapMailError(services, session.userId, error);
      }
    },
  );

  /** Préférences, avec les limites utiles au composeur (même forme pour GET et PATCH). */
  const preferencesView = async (userId: string) => {
    const security = services.config().security;
    return {
      ...(await services.preferences.get(userId)),
      limits: {
        maxAttachmentSize: security.max_attachment_size,
        maxUploadTotal: security.max_upload_total,
      },
    };
  };

  app.get('/me/preferences', auth, async (request) => {
    const session = request.session as SessionData;
    return preferencesView(session.userId);
  });

  app.patch('/me/preferences', auth, async (request) => {
    const session = request.session as SessionData;
    const parsed = preferencesPatch.safeParse(request.body);
    if (!parsed.success) throw badRequest();
    await services.preferences.update(session.userId, parsed.data);
    // Journal d'audit : noms des champs modifiés uniquement (jamais leurs valeurs).
    await services.audit.record({
      event: 'preferences_updated',
      userId: session.userId,
      ip: request.ip,
      metadata: { fields: Object.keys(parsed.data).sort() },
    });
    return preferencesView(session.userId);
  });

  app.put(
    '/me/avatar',
    { ...auth, bodyLimit: Math.ceil((AVATAR_MAX_INPUT * 4) / 3) + 1024 },
    async (request, reply) => {
      const session = request.session as SessionData;
      const parsed = avatarBody.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      let image: Buffer;
      try {
        image = await reencodeAvatar(Buffer.from(parsed.data.data, 'base64'));
      } catch (error) {
        if (error instanceof AvatarError) throw new HttpError(422, 'invalid_image');
        throw error;
      }
      await services.preferences.setAvatar(session.userId, image);
      await services.audit.record({
        event: 'preferences_updated',
        userId: session.userId,
        ip: request.ip,
        metadata: { fields: ['avatar'] },
      });
      return reply.status(204).send();
    },
  );

  app.delete('/me/avatar', auth, async (request, reply) => {
    const session = request.session as SessionData;
    await services.preferences.removeAvatar(session.userId);
    await services.audit.record({
      event: 'preferences_updated',
      userId: session.userId,
      ip: request.ip,
      metadata: { fields: ['avatar'] },
    });
    return reply.status(204).send();
  });

  /** Photo de l'utilisateur connecté uniquement (aucun accès à celle d'un autre compte). */
  app.get('/me/avatar', auth, async (request, reply) => {
    const session = request.session as SessionData;
    const avatar = await services.preferences.getAvatar(session.userId);
    if (!avatar) throw notFound();
    return reply
      .header('Content-Type', 'image/webp')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-cache')
      .header('ETag', `"${avatar.updatedAt.getTime()}"`)
      .send(avatar.image);
  });
}
