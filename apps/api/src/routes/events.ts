import type { FastifyInstance } from 'fastify';
import { requireSession } from '../plugins/session.js';
import type { SessionData } from '../services/sessions.js';

const HEARTBEAT_MS = 25_000;
const SESSION_CHECK_MS = 60_000;
const MAX_STREAMS_PER_USER = 3;

/**
 * Événements temps réel (Server-Sent Events) : une connexion IMAP IDLE sur la boîte de réception
 * signale l'arrivée de messages et les changements d'état. Le flux se ferme dès que la session
 * n'est plus valide.
 */
export async function eventRoutes(app: FastifyInstance) {
  const services = app.services;
  const streams = new Map<string, number>();

  app.get('/events', { preHandler: requireSession(['full']) }, async (request, reply) => {
    const session = request.session as SessionData;
    const sessionId = request.sessionId as string;
    const userId = session.userId;
    const count = streams.get(userId) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) {
      return reply.status(429).send({ error: 'too_many_streams' });
    }

    let client;
    try {
      client = await services.mail.idleClient(userId);
      await client.mailboxOpen('INBOX', { readOnly: true });
    } catch {
      await client?.logout().catch(() => undefined);
      return reply.status(503).send({ error: 'imap_unavailable' });
    }
    streams.set(userId, count + 1);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('ready', { folder: 'INBOX' });

    client.on('exists', (info: { path: string; count: number; prevCount: number }) => {
      send('mailbox', { folder: info.path, exists: info.count, previous: info.prevCount });
    });
    client.on('expunge', (info: { path: string }) => send('mailbox', { folder: info.path }));
    client.on('flags', (info: { path: string }) => send('flags', { folder: info.path }));

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      const remaining = (streams.get(userId) ?? 1) - 1;
      if (remaining <= 0) streams.delete(userId);
      else streams.set(userId, remaining);
      client.logout().catch(() => client.close());
      res.end();
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const sessionCheck = setInterval(() => {
      services.sessions.peek(sessionId).then(
        (current) => {
          if (!current) close();
        },
        () => close(),
      );
    }, SESSION_CHECK_MS);
    client.on('close', close);
    request.raw.on('close', close);
  });
}
