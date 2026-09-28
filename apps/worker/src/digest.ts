import type { DbHandle } from '@plume/db';
import { buildMime, escapeHtml, ImapFlow, imapOptions, sendRaw } from '@plume/mail';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AccountInfo } from './processor.js';

/** Heure locale (fuseau TZ du conteneur) à partir de laquelle le résumé du jour est envoyé. */
export const DIGEST_HOUR = 7;
const MAX_ITEMS = 50;
const MAX_SCAN = 200;

export interface DigestDeps {
  db: DbHandle['db'];
  account: (userId: string) => Promise<AccountInfo | null>;
  logger: Logger;
  send?: typeof sendRaw;
  now?: () => Date;
}

const TEXT = {
  fr: {
    subject: (n: number) => `Plume — ${n} message(s) non lu(s) depuis hier`,
    intro: (n: number) => `Vous avez ${n} message(s) non lu(s) reçu(s) ces dernières 24 heures :`,
    more: (n: number) => `… et ${n} autre(s).`,
    noSubject: '(sans objet)',
    footer: 'Résumé quotidien envoyé par Plume. Désactivable dans Paramètres › Général.',
  },
  en: {
    subject: (n: number) => `Plume — ${n} unread message(s) since yesterday`,
    intro: (n: number) => `You have ${n} unread message(s) received in the last 24 hours:`,
    more: (n: number) => `… and ${n} more.`,
    noSubject: '(no subject)',
    footer: 'Daily digest sent by Plume. You can turn it off in Settings › General.',
  },
};

/** Début de la fenêtre d'envoi du jour (aujourd'hui à DIGEST_HOUR, heure locale). */
export function digestSlot(now: Date): Date {
  const slot = new Date(now);
  slot.setHours(DIGEST_HOUR, 0, 0, 0);
  return slot;
}

/**
 * Envoie le résumé quotidien (messages non lus des dernières 24 h de la boîte de réception) aux
 * utilisateurs qui l'ont activé, une fois par jour. Seuls l'expéditeur et l'objet figurent dans
 * le résumé, jamais le contenu des messages. Aucun envoi s'il n'y a rien à signaler.
 */
export async function sendDueDigests(
  deps: DigestDeps,
): Promise<{ sent: number; empty: number; failed: number }> {
  const now = deps.now?.() ?? new Date();
  const slot = digestSlot(now);
  const result = { sent: 0, empty: 0, failed: 0 };
  if (now < slot) return result;
  const rows = await deps.db.execute<{ user_id: string; language: string }>(sql`
    SELECT p.user_id, p.language FROM preferences p JOIN users u ON u.id = p.user_id
    WHERE u.suspended_at IS NULL
      AND (p.notifications->>'dailyDigest')::boolean IS TRUE
      AND (p.last_digest_at IS NULL OR p.last_digest_at < ${slot})`);

  for (const { user_id: userId, language } of rows.rows) {
    // Réservation du créneau avant l'envoi : au plus un résumé par jour, même en cas d'erreur.
    const claimed = await deps.db.execute(sql`
      UPDATE preferences SET last_digest_at = ${now}
      WHERE user_id = ${userId} AND (last_digest_at IS NULL OR last_digest_at < ${slot})
      RETURNING user_id`);
    if (claimed.rows.length === 0) continue;
    const text = language === 'en' ? TEXT.en : TEXT.fr;
    try {
      const account = await deps.account(userId);
      if (!account) throw new Error('account_unavailable');
      const client = new ImapFlow(
        imapOptions(account.imap.target, { user: account.imap.user, pass: account.imap.pass }),
      );
      client.on('error', () => undefined);
      await client.connect();
      let items: { from: string; subject: string }[] = [];
      let total = 0;
      try {
        const lock = await client.getMailboxLock('INBOX', { readOnly: true });
        try {
          const since = new Date(now.getTime() - 24 * 3_600_000);
          const uids = ((await client.search({ seen: false, since }, { uid: true })) || []).sort(
            (a, b) => b - a,
          );
          // Les messages envoyés par le compte à lui-même (dont les résumés précédents) sont exclus.
          const found: { uid: number; from: string; subject: string }[] = [];
          if (uids.length > 0) {
            const range = uids.slice(0, MAX_SCAN).join(',');
            for await (const msg of client.fetch(range, { envelope: true }, { uid: true })) {
              const sender = msg.envelope?.from?.[0];
              if (sender?.address?.toLowerCase() === account.email.toLowerCase()) continue;
              found.push({
                uid: msg.uid,
                from: sender?.name || sender?.address || '?',
                subject: msg.envelope?.subject || text.noSubject,
              });
            }
          }
          items = found
            .sort((a, b) => b.uid - a.uid)
            .map(({ from, subject }) => ({ from, subject }));
          total = items.length + Math.max(0, uids.length - MAX_SCAN);
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => client.close());
      }
      if (total === 0) {
        result.empty += 1;
        continue;
      }
      items = items.slice(0, MAX_ITEMS);
      const html =
        `<p>${escapeHtml(text.intro(total))}</p><ul>` +
        items
          .map((i) => `<li><b>${escapeHtml(i.from)}</b> — ${escapeHtml(i.subject)}</li>`)
          .join('') +
        `</ul>${total > items.length ? `<p>${escapeHtml(text.more(total - items.length))}</p>` : ''}` +
        `<p>${escapeHtml(text.footer)}</p>`;
      const raw = await buildMime({
        from: { name: 'Plume', address: account.email },
        to: [{ name: '', address: account.email }],
        cc: [],
        bcc: [],
        subject: text.subject(total),
        html,
        attachments: [],
        automatic: 'digest',
      });
      await (deps.send ?? sendRaw)(account.smtp, { from: account.email, to: [account.email] }, raw);
      result.sent += 1;
    } catch (err) {
      deps.logger.warn({ userId, err }, 'résumé quotidien impossible');
      result.failed += 1;
    }
  }
  return result;
}
