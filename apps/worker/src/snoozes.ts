import type { SnoozesRepository } from '@plume/db';
import { ImapFlow, imapOptions, wakeMessage } from '@plume/mail';
import type { Logger } from 'pino';
import type { AccountInfo } from './processor.js';

export interface SnoozeWakerDeps {
  repo: SnoozesRepository;
  account: (userId: string) => Promise<AccountInfo | null>;
  logger: Logger;
  now?: () => Date;
}

/**
 * Réveille les messages reportés arrivés à échéance. Un message introuvable (déplacé ou supprimé
 * entre-temps) clôt le report ; une erreur de connexion le repousse (délai croissant).
 */
export async function wakeDueSnoozes(
  deps: SnoozeWakerDeps,
): Promise<{ woken: number; dropped: number; failed: number }> {
  const due = await deps.repo.due(deps.now?.() ?? new Date());
  const byUser = new Map<string, typeof due>();
  for (const snooze of due)
    byUser.set(snooze.userId, [...(byUser.get(snooze.userId) ?? []), snooze]);
  const result = { woken: 0, dropped: 0, failed: 0 };

  for (const [userId, snoozes] of byUser) {
    const account = await deps.account(userId);
    if (!account) {
      // Compte suspendu ou domaine retiré : le report attendra (ou sera abandonné après 10 essais).
      for (const s of snoozes) await deps.repo.postpone(s.id);
      result.failed += snoozes.length;
      continue;
    }
    const client = new ImapFlow(
      imapOptions(account.imap.target, { user: account.imap.user, pass: account.imap.pass }),
    );
    client.on('error', () => undefined);
    try {
      await client.connect();
      for (const s of snoozes) {
        try {
          const woke = await wakeMessage(client, {
            folder: s.folder,
            uidValidity: String(s.uidValidity),
            uid: s.uid,
            messageId: s.messageId,
            returnTo: s.returnTo,
          });
          await deps.repo.delete(s.id);
          if (woke) result.woken += 1;
          else result.dropped += 1;
        } catch (err) {
          deps.logger.warn({ userId, err }, 'réveil d’un report impossible');
          await deps.repo.postpone(s.id);
          result.failed += 1;
        }
      }
    } catch (err) {
      deps.logger.warn({ userId, err }, 'connexion IMAP impossible pour les reports');
      for (const s of snoozes) await deps.repo.postpone(s.id);
      result.failed += snoozes.length;
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
  return result;
}
