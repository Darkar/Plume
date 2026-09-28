import type { ImapFlow } from 'imapflow';
import {
  isValidLabel,
  listFolders,
  MailboxError,
  type Folder,
  type MessageRef,
} from './mailbox.js';

/**
 * Actions sur les messages : drapeaux, libellés (mots-clés IMAP), déplacement, archivage,
 * corbeille. Chaque action est faite par UID, sous le verrou de la boîte concernée.
 */

export class ActionError extends Error {
  constructor(readonly code: 'invalid_label' | 'invalid_folder' | 'same_folder') {
    super(code);
    this.name = 'ActionError';
  }
}

async function withWriteLock<T>(
  client: ImapFlow,
  ref: MessageRef,
  fn: () => Promise<T>,
): Promise<T> {
  let lock;
  try {
    lock = await client.getMailboxLock(ref.folder);
  } catch {
    throw new MailboxError('folder_not_found');
  }
  try {
    const mailbox = client.mailbox;
    if (!mailbox || String(mailbox.uidValidity) !== ref.uidValidity) {
      throw new MailboxError('message_not_found');
    }
    const exists = await client.search({ uid: String(ref.uid) }, { uid: true });
    if (!exists || exists.length === 0) throw new MailboxError('message_not_found');
    return await fn();
  } finally {
    lock.release();
  }
}

export interface FlagChanges {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
}

export async function updateFlags(
  client: ImapFlow,
  ref: MessageRef,
  changes: FlagChanges,
): Promise<void> {
  const add = [...(changes.addLabels ?? [])];
  const remove = [...(changes.removeLabels ?? [])];
  for (const label of [...add, ...remove]) {
    if (!isValidLabel(label)) throw new ActionError('invalid_label');
  }
  if (changes.seen === true) add.push('\\Seen');
  if (changes.seen === false) remove.push('\\Seen');
  if (changes.flagged === true) add.push('\\Flagged');
  if (changes.flagged === false) remove.push('\\Flagged');
  if (changes.answered === true) add.push('\\Answered');
  await withWriteLock(client, ref, async () => {
    const uid = String(ref.uid);
    if (add.length > 0) await client.messageFlagsAdd(uid, add, { uid: true });
    if (remove.length > 0) await client.messageFlagsRemove(uid, remove, { uid: true });
  });
}

const SPECIAL_DEFAULT_NAMES: Record<string, string> = {
  '\\Archive': 'Archives',
  '\\Junk': 'Junk',
  '\\Trash': 'Trash',
  '\\Sent': 'Sent',
  '\\Drafts': 'Drafts',
};

/** Trouve (ou crée) le dossier ayant l'usage spécial donné. */
export async function specialFolder(
  client: ImapFlow,
  use: keyof typeof SPECIAL_DEFAULT_NAMES,
): Promise<string> {
  const folders = await listFolders(client, { counts: false });
  const found = folders.find((f) => f.specialUse === use);
  if (found) return found.path;
  const name = SPECIAL_DEFAULT_NAMES[use] as string;
  const byName = folders.find((f) => f.path.toLowerCase() === name.toLowerCase());
  if (byName) return byName.path;
  const created = await client.mailboxCreate(name);
  return created.path;
}

export async function folderExists(client: ImapFlow, path: string): Promise<Folder | null> {
  return (await listFolders(client, { counts: false })).find((f) => f.path === path) ?? null;
}

/**
 * Déplace un message et renvoie sa nouvelle référence (UIDPLUS, ou recherche par Message-ID
 * à défaut) pour permettre l'annulation.
 */
export async function moveMessage(
  client: ImapFlow,
  ref: MessageRef,
  destination: string,
): Promise<MessageRef | null> {
  if (destination === ref.folder) throw new ActionError('same_folder');
  if (!(await folderExists(client, destination))) throw new ActionError('invalid_folder');
  let messageId: string | undefined;
  const result = await withWriteLock(client, ref, async () => {
    const msg = await client.fetchOne(
      String(ref.uid),
      { uid: true, envelope: true },
      { uid: true },
    );
    messageId = msg ? msg.envelope?.messageId : undefined;
    return client.messageMove(String(ref.uid), destination, { uid: true });
  });
  if (!result) return null;
  const newUid = result.uidMap?.get(ref.uid);
  if (newUid !== undefined && result.uidValidity !== undefined) {
    return { folder: destination, uidValidity: String(result.uidValidity), uid: newUid };
  }
  // Serveur sans UIDPLUS : on retrouve le message par son en-tête Message-ID.
  if (!messageId) return null;
  const lock = await client.getMailboxLock(destination, { readOnly: true });
  try {
    const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    const uid = found && found.length > 0 ? Math.max(...found) : undefined;
    const mailbox = client.mailbox;
    return uid !== undefined && mailbox
      ? { folder: destination, uidValidity: String(mailbox.uidValidity), uid }
      : null;
  } finally {
    lock.release();
  }
}

export async function archiveMessage(
  client: ImapFlow,
  ref: MessageRef,
): Promise<MessageRef | null> {
  return moveMessage(client, ref, await specialFolder(client, '\\Archive'));
}

/**
 * Signale un message comme indésirable : déplacement vers le dossier « \\Junk » (créé au besoin).
 * Les filtres du serveur qui apprennent des déplacements (IMAPSieve, rspamd) en profitent.
 */
export async function junkMessage(client: ImapFlow, ref: MessageRef): Promise<MessageRef | null> {
  return moveMessage(client, ref, await specialFolder(client, '\\Junk'));
}

/** Supprime : déplacement vers la corbeille, ou suppression définitive depuis la corbeille. */
export async function deleteMessage(
  client: ImapFlow,
  ref: MessageRef,
): Promise<{ permanent: boolean; ref: MessageRef | null }> {
  const trash = await specialFolder(client, '\\Trash');
  if (ref.folder === trash) {
    await withWriteLock(client, ref, () => client.messageDelete(String(ref.uid), { uid: true }));
    return { permanent: true, ref: null };
  }
  return { permanent: false, ref: await moveMessage(client, ref, trash) };
}

/** Copie un message envoyé dans le dossier « Envoyés ». */
export async function appendSent(client: ImapFlow, raw: Buffer): Promise<void> {
  const sent = await specialFolder(client, '\\Sent');
  await client.append(sent, raw, ['\\Seen']);
}

/** Dossier des messages reportés (IMAP n'a pas d'usage spécial pour cela). */
export const SNOOZE_FOLDER = 'Reportés';

export async function ensureFolder(client: ImapFlow, name: string): Promise<string> {
  const existing = await folderExists(client, name);
  if (existing) return existing.path;
  return (await client.mailboxCreate(name)).path;
}

/** Reporte un message : déplacement dans le dossier des reports. */
export async function snoozeMessage(
  client: ImapFlow,
  ref: MessageRef,
): Promise<{ ref: MessageRef | null; messageId: string | null }> {
  const folder = await ensureFolder(client, SNOOZE_FOLDER);
  if (ref.folder === folder) throw new ActionError('same_folder');
  let messageId: string | null = null;
  await withWriteLock(client, ref, async () => {
    const msg = await client.fetchOne(
      String(ref.uid),
      { uid: true, envelope: true },
      { uid: true },
    );
    messageId = (msg && msg.envelope?.messageId) || null;
  });
  return { ref: await moveMessage(client, ref, folder), messageId };
}

/**
 * Réveille un message reporté : il revient dans son dossier d'origine (ou la boîte de
 * réception), marqué non lu. Renvoie false si le message n'est plus dans le dossier des reports
 * (déplacé ou supprimé entre-temps par l'utilisateur).
 */
export async function wakeMessage(
  client: ImapFlow,
  snooze: {
    folder: string;
    uidValidity: string;
    uid: number;
    messageId: string | null;
    returnTo: string;
  },
  options: { markUnseen: boolean } = { markUnseen: true },
): Promise<boolean> {
  let lock;
  try {
    lock = await client.getMailboxLock(snooze.folder);
  } catch {
    return false;
  }
  let uid: number | undefined;
  try {
    const mailbox = client.mailbox;
    if (mailbox && String(mailbox.uidValidity) === snooze.uidValidity) {
      const found = await client.search({ uid: String(snooze.uid) }, { uid: true });
      if (found && found.length > 0) uid = snooze.uid;
    }
    if (uid === undefined && snooze.messageId) {
      const found = await client.search(
        { header: { 'message-id': snooze.messageId } },
        { uid: true },
      );
      if (found && found.length > 0) uid = Math.max(...found);
    }
    if (uid === undefined) return false;
    if (options.markUnseen) await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    const destination = (await folderExists(client, snooze.returnTo)) ? snooze.returnTo : 'INBOX';
    await client.messageMove(String(uid), destination, { uid: true });
    return true;
  } finally {
    lock.release();
  }
}
