import {
  deleteLabel,
  downloadPart,
  getMessage,
  htmlToText,
  ImapAuthError,
  ImapUnavailableError,
  listFolders,
  listLabels,
  listMessages,
  MailboxError,
  SafeFetchError,
  BODY_HEIGHT_SCRIPT_HASH,
  sanitizeEmailHtml,
  sanitizeOutgoingHtml,
  escapeHtml,
  sniffImageType,
  textToSafeHtml,
  type AttachmentInfo,
  type MessageDetail,
  type MessageRef,
  type MessageSummary,
} from '@plume/mail';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../context.js';
import {
  contentDisposition,
  decodeAttachmentId,
  decodeCursor,
  decodeMessageId,
  encodeAttachmentId,
  encodeCursor,
  encodeMessageId,
} from '../lib/ids.js';
import { badRequest, HttpError, notFound } from '../lib/http.js';
import { requireSession } from '../plugins/session.js';
import { AccountUnavailableError } from '../services/mail-access.js';
import type { SessionData } from '../services/sessions.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_TTL_MS = 60 * 60_000;
const PREVIEWABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const listQuery = z.strictObject({
  folder: z.string().min(1).max(500).default('INBOX'),
  filter: z.enum(['all', 'unseen', 'flagged', 'attachments']).default('all'),
  label: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/)
    .optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const labelParam = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/),
});
export const bodyQuery = z.strictObject({
  images: z.enum(['0', '1']).optional(),
  theme: z.enum(['light', 'dark']).optional(),
});
export const attachmentQuery = z.strictObject({
  inline: z.enum(['0', '1']).optional(),
  u: z.string().uuid().optional(),
  exp: z.coerce.number().int().optional(),
  sig: z.string().max(64).optional(),
});
export const proxyQuery = z.strictObject({
  url: z.string().min(1).max(4096),
  exp: z.coerce.number().int(),
  sig: z.string().max(64),
});

/** Traduit les erreurs IMAP en réponses HTTP sans détail interne. */
/** Cache des libellés par utilisateur (voir GET /labels). */
const labelCache = new Map<string, { labels: string[]; expires: number }>();

export function invalidateLabels(userId: string): void {
  labelCache.delete(userId);
}

export function mapMailError(services: Services, userId: string, error: unknown): never {
  if (error instanceof MailboxError) {
    const status = error.code === 'too_large' ? 413 : error.code === 'stale_cursor' ? 409 : 404;
    throw new HttpError(status, error.code);
  }
  if (error instanceof ImapAuthError) {
    services.mail.pool.release(userId);
    throw new HttpError(401, 'imap_auth_failed');
  }
  if (error instanceof ImapUnavailableError) throw new HttpError(503, 'imap_unavailable');
  if (error instanceof AccountUnavailableError) throw new HttpError(403, 'account_unavailable');
  // Connexion IMAP interrompue en cours de commande : on la jette pour la suivante.
  const err = error as { code?: string };
  if (err.code === 'NoConnection' || err.code === 'EConnectionClosed') {
    services.mail.pool.release(userId);
    throw new HttpError(503, 'imap_unavailable');
  }
  throw error;
}

export function summaryView(summary: MessageSummary) {
  const { ref, ...rest } = summary;
  return { id: encodeMessageId(ref), folder: ref.folder, ...rest };
}

function attachmentView(ref: MessageRef, attachment: AttachmentInfo) {
  return {
    id: encodeAttachmentId(ref, attachment.part),
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    inline: attachment.inline,
    previewable: PREVIEWABLE.has(attachment.contentType),
  };
}

function detailView(detail: MessageDetail) {
  return {
    ...summaryView(detail),
    cc: detail.cc,
    bcc: detail.bcc,
    replyTo: detail.replyTo,
    messageId: detail.messageId,
    inReplyTo: detail.inReplyTo,
    attachments: detail.attachments.map((a) => attachmentView(detail.ref, a)),
  };
}

export async function mailRoutes(app: FastifyInstance) {
  const services = app.services;

  async function withMailbox<T>(
    userId: string,
    fn: (client: Awaited<ReturnType<typeof services.mail.pool.acquire>>) => Promise<T>,
  ): Promise<T> {
    try {
      const client = await services.mail.pool.acquire(userId);
      return await fn(client);
    } catch (error) {
      return mapMailError(services, userId, error);
    }
  }

  function messageRef(request: FastifyRequest): MessageRef {
    const { id } = request.params as { id: string };
    const ref = decodeMessageId(id);
    if (!ref) throw notFound();
    return ref;
  }

  const auth = { preHandler: requireSession(['full']) };

  app.get('/folders', auth, async (request) => {
    const session = request.session as SessionData;
    const folders = await withMailbox(session.userId, (client) => listFolders(client));
    return { folders };
  });

  /**
   * Libellés utilisés dans la boîte de réception et les archives. Le recensement parcourt les
   * messages récents sur la connexion IMAP de l'utilisateur : résultat gardé 60 s en mémoire
   * (invalidé quand l'utilisateur modifie un libellé).
   */
  app.get('/labels', auth, async (request) => {
    const session = request.session as SessionData;
    const cached = labelCache.get(session.userId);
    if (cached && cached.expires > services.now()) return { labels: cached.labels };
    const labels = await withMailbox(session.userId, async (client) => {
      const folders = await listFolders(client, { counts: false });
      const scanned = folders
        .filter((f) => f.specialUse === '\\Inbox' || f.specialUse === '\\Archive')
        .map((f) => f.path);
      return listLabels(client, scanned.length > 0 ? scanned : ['INBOX']);
    });
    labelCache.set(session.userId, { labels, expires: services.now() + 60_000 });
    return { labels };
  });

  /**
   * Supprime un libellé : le mot-clé est retiré de tous les messages qui le portent, dans
   * tous les dossiers de l'utilisateur.
   */
  app.delete('/labels/:name', auth, async (request) => {
    const session = request.session as SessionData;
    const parsed = labelParam.safeParse(request.params);
    if (!parsed.success) throw notFound();
    const removed = await withMailbox(session.userId, async (client) => {
      const folders = await listFolders(client, { counts: false });
      return deleteLabel(
        client,
        parsed.data.name,
        folders.map((f) => f.path),
      );
    });
    invalidateLabels(session.userId);
    return { removed };
  });

  app.get('/messages', auth, async (request) => {
    const session = request.session as SessionData;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest();
    const { folder, filter, q, cursor, limit, label } = parsed.data;
    const position = cursor ? decodeCursor(cursor) : null;
    if (cursor && !position) throw badRequest('invalid_cursor');
    const result = await withMailbox(session.userId, (client) =>
      listMessages(client, {
        folder,
        filter,
        query: q || undefined,
        label,
        limit,
        before: position?.before,
        uidValidity: position?.uidValidity,
      }),
    );
    return {
      messages: result.messages.map(summaryView),
      nextCursor:
        result.nextBefore !== null ? encodeCursor(result.uidValidity, result.nextBefore) : null,
      total: result.total,
    };
  });

  app.get('/messages/:id', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = messageRef(request);
    const content = await withMailbox(session.userId, (client) =>
      getMessage(client, ref, { markSeen: true, maxBodyBytes: MAX_BODY_BYTES }),
    );
    // Nombre d'images distantes que le rendu bloquerait (bandeau « Afficher les images »).
    const blockedRemoteImages =
      content.html !== null && services.config().security.remote_images !== 'allow'
        ? sanitizeEmailHtml(content.html, { remoteImages: 'block' }).blockedRemote
        : 0;
    return {
      ...detailView(content.detail),
      remoteImagesPolicy: services.config().security.remote_images,
      blockedRemoteImages,
    };
  });

  /**
   * Corps d'un brouillon, pour le reprendre dans l'éditeur : HTML nettoyé comme un message
   * sortant (le composeur l'insère tel quel). Réservé aux messages marqués \\Draft.
   */
  app.get('/messages/:id/draft', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = messageRef(request);
    const content = await withMailbox(session.userId, (client) =>
      getMessage(client, ref, { markSeen: false, maxBodyBytes: MAX_BODY_BYTES }),
    );
    if (!content.detail.draft) throw notFound();
    const html =
      content.html !== null
        ? sanitizeOutgoingHtml(content.html)
        : escapeHtml(content.text ?? '').replace(/\r?\n/g, '<br>');
    return { html };
  });

  /** Texte brut du message, pour la citation dans une réponse ou un transfert. */
  app.get('/messages/:id/quote', auth, async (request) => {
    const session = request.session as SessionData;
    const ref = messageRef(request);
    const content = await withMailbox(session.userId, (client) =>
      getMessage(client, ref, { markSeen: false, maxBodyBytes: MAX_BODY_BYTES }),
    );
    const text =
      content.html !== null
        ? htmlToText(sanitizeEmailHtml(content.html, { remoteImages: 'block' }).html)
        : (content.text ?? '');
    return { text: text.slice(0, 20_000) };
  });

  /**
   * Corps du message, nettoyé, servi comme document autonome pour une iframe `sandbox`
   * (sans allow-scripts ni allow-same-origin) avec sa propre CSP.
   */
  app.get('/messages/:id/body', auth, async (request, reply) => {
    const session = request.session as SessionData;
    const ref = messageRef(request);
    const parsed = bodyQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest();
    const showImages =
      parsed.data.images === '1' || services.config().security.remote_images === 'allow';

    const content = await withMailbox(session.userId, (client) =>
      getMessage(client, ref, { markSeen: false, maxBodyBytes: MAX_BODY_BYTES }),
    );
    const now = services.now();
    const expiresAt = now + SIGNED_URL_TTL_MS;
    const byCid = new Map(
      content.detail.attachments.filter((a) => a.contentId).map((a) => [a.contentId as string, a]),
    );
    const result =
      content.html !== null
        ? sanitizeEmailHtml(content.html, {
            remoteImages: showImages ? 'proxy' : 'block',
            resolveCid: (cid) => {
              const attachment = byCid.get(cid);
              if (!attachment) return null;
              const id = encodeAttachmentId(ref, attachment.part);
              const sig = services.signer.sign('attachment', [id, session.userId], expiresAt);
              return `/api/v1/attachments/${id}?inline=1&u=${session.userId}&exp=${expiresAt}&sig=${sig}`;
            },
            proxyUrl: (url) => {
              const sig = services.signer.sign('image-proxy', [url], expiresAt);
              return `/api/v1/image-proxy?url=${encodeURIComponent(url)}&exp=${expiresAt}&sig=${sig}`;
            },
            theme: parsed.data.theme,
          })
        : textToSafeHtml(content.text ?? '', parsed.data.theme);

    const origin = services.config().server.public_url;
    return reply
      .header(
        'Content-Security-Policy',
        [
          "default-src 'none'",
          // Seul le script de mesure de hauteur (empreinte) : aucun script du mail.
          `script-src ${BODY_HEIGHT_SCRIPT_HASH}`,
          `img-src 'self' ${origin} data:`,
          "style-src 'unsafe-inline'",
          "font-src 'none'",
          "frame-ancestors 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          // Origine opaque (pas d'allow-same-origin) : le script ne voit ni cookies ni l'interface.
          'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
        ].join('; '),
      )
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Cache-Control', 'private, no-store')
      .header('X-Plume-Blocked-Images', String(result.blockedRemote))
      .type('text/html; charset=utf-8')
      .send(result.html);
  });

  /**
   * Pièce jointe. Deux modes d'accès :
   * - session (cookie) : téléchargement, ou aperçu isolé des PDF / images ;
   * - URL signée (images `cid:` chargées par l'iframe isolée, qui n'envoie pas de cookie).
   */
  app.get('/attachments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const decoded = decodeAttachmentId(id);
    if (!decoded) throw notFound();
    const parsed = attachmentQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest();
    const { inline, u, exp, sig } = parsed.data;

    let userId: string;
    let signed = false;
    if (sig !== undefined) {
      if (
        !u ||
        exp === undefined ||
        !services.signer.verify('attachment', [id, u], exp, sig, services.now())
      ) {
        throw new HttpError(403, 'invalid_signature');
      }
      userId = u;
      signed = true;
    } else {
      await requireSession(['full'])(request);
      userId = (request.session as SessionData).userId;
    }

    const maxBytes = services.config().security.max_attachment_size;
    const { info, content } = await withMailbox(userId, (client) =>
      downloadPart(client, decoded.ref, decoded.part, maxBytes),
    );

    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Length', String(content.length));

    const wantsInline = inline === '1';
    if (wantsInline) {
      // Aperçu : uniquement si le contenu RÉEL est une image raster ou un PDF (le type annoncé
      // par l'expéditeur n'est pas fiable), servi dans un bac à sable sans script.
      const sniffed =
        sniffImageType(content) ??
        (content.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null);
      if (!sniffed || (signed && sniffed === 'application/pdf')) {
        throw new HttpError(415, 'preview_unavailable');
      }
      // Toujours dans un bac à sable (CSP « sandbox ») : l'aperçu intégré des PDF passe par la
      // visionneuse isolée de l'interface (pdf.js), qui lit ces octets par fetch.
      const csp =
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox";
      return (
        reply
          .header('Content-Type', sniffed)
          .header('Content-Disposition', contentDisposition('inline', info.filename))
          .header('Content-Security-Policy', csp)
          // Aperçu affiché dans une iframe de l'interface.
          .header('X-Frame-Options', 'SAMEORIGIN')
          .header('Cross-Origin-Resource-Policy', signed ? 'cross-origin' : 'same-origin')
          .send(content)
      );
    }
    if (signed) throw new HttpError(403, 'invalid_signature');
    // Téléchargement : type générique, jamais interprété par le navigateur.
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', contentDisposition('attachment', info.filename))
      .send(content);
  });

  /** Proxy d'images distantes : URL signée, anti-SSRF, sans cookie ni référent. */
  app.get('/image-proxy', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = proxyQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest();
    const { url, exp, sig } = parsed.data;
    if (!services.signer.verify('image-proxy', [url], exp, sig, services.now())) {
      throw new HttpError(403, 'invalid_signature');
    }
    if (await services.limiter.hit('image-proxy', request.ip, 600, 60_000)) {
      throw new HttpError(429, 'rate_limited');
    }
    let image;
    try {
      image = await services.fetchImage(url);
    } catch (error) {
      if (error instanceof SafeFetchError) {
        request.log.info({ reason: error.reason }, 'image distante refusée');
        throw new HttpError(error.reason === 'forbidden_address' ? 403 : 502, 'image_unavailable');
      }
      throw error;
    }
    return reply
      .header('Content-Type', image.contentType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Cache-Control', 'private, max-age=3600')
      .header('Content-Disposition', 'inline')
      .send(image.body);
  });
}
