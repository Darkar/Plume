import type { ImapFlow } from 'imapflow';
import { ALLOWED_HEADERS, type Action, type MessageFacts, type Rule } from '@plume/rules';
import { specialFolder, updateFlags, moveMessage, deleteMessage } from './actions.js';
import { htmlToText } from './compose.js';
import {
  analyzeStructure,
  decodeCharset,
  decodeQuotedPrintable,
  parseHeaders,
  type MessageRef,
} from './mailbox.js';

/** Taille maximale du corps texte lu pour l'évaluation d'une règle. */
const MAX_FACT_BODY_BYTES = 64 * 1024;
const EXTRA_HEADERS = ['x-plume-forwarded', 'message-id', 'references'];

export interface MessageEnvelopeFacts {
  uid: number;
  facts: MessageFacts;
  /** En-têtes bruts utiles au moteur (anti-boucle, fil de discussion). */
  rawHeaders: Record<string, string[]>;
  messageId: string | null;
}

/** Les règles lisent-elles le corps ? (sinon on évite de le télécharger). */
export function rulesNeedBody(rules: Rule[]): boolean {
  return rules.some((r) => r.enabled && r.conditions.some((c) => c.field === 'body_text'));
}

async function readLimited(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    size += buffer.length;
    if (size >= max) break;
  }
  return Buffer.concat(chunks).subarray(0, max);
}

/** Extrait les faits de messages (par UID) pour l'évaluation des règles. */
export async function fetchFacts(
  client: ImapFlow,
  folder: string,
  uids: number[],
  options: { withBody: boolean },
): Promise<MessageEnvelopeFacts[]> {
  if (uids.length === 0) return [];
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const results: MessageEnvelopeFacts[] = [];
    const fetched = [];
    for await (const msg of client.fetch(
      uids.join(','),
      {
        uid: true,
        envelope: true,
        bodyStructure: true,
        size: true,
        headers: [...ALLOWED_HEADERS, ...EXTRA_HEADERS],
      },
      { uid: true },
    )) {
      fetched.push(msg);
    }
    for (const msg of fetched) {
      const structure = analyzeStructure(msg.bodyStructure);
      const headers = parseHeaders(msg.headers?.toString('utf8') ?? '');
      let bodyText = '';
      const part = options.withBody ? (structure.textPart ?? structure.htmlPart) : null;
      if (part) {
        try {
          const { content, meta } = await client.download(String(msg.uid), part, {
            uid: true,
            maxBytes: MAX_FACT_BODY_BYTES,
          });
          let raw = await readLimited(content, MAX_FACT_BODY_BYTES);
          const declared = structure.encodings.get(part);
          if (!meta.encoding && declared?.encoding === 'quoted-printable')
            raw = decodeQuotedPrintable(raw);
          if (!meta.encoding && declared?.encoding === 'base64')
            raw = Buffer.from(raw.toString('latin1'), 'base64');
          const text = meta.charset
            ? raw.toString('utf8')
            : decodeCharset(raw, declared?.charset ?? 'utf-8');
          bodyText = part === structure.htmlPart ? htmlToText(text) : text;
        } catch {
          bodyText = '';
        }
      }
      const addresses = (list: { name?: string; address?: string }[] | undefined) =>
        (list ?? []).map((a) => ({ name: a.name ?? '', address: (a.address ?? '').toLowerCase() }));
      const factsHeaders: Record<string, string[]> = {};
      for (const name of ALLOWED_HEADERS) if (headers[name]) factsHeaders[name] = headers[name];
      results.push({
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? null,
        rawHeaders: headers,
        facts: {
          from: addresses(msg.envelope?.from),
          to: addresses(msg.envelope?.to),
          cc: addresses(msg.envelope?.cc),
          subject: msg.envelope?.subject ?? '',
          bodyText,
          attachments: structure.attachments
            .filter((a) => !a.inline)
            .map((a) => ({ filename: a.filename })),
          size: msg.size ?? 0,
          headers: factsHeaders,
        },
      });
    }
    return results;
  } finally {
    lock.release();
  }
}

export interface SideEffects {
  forward(to: string): Promise<void>;
  autoReply(action: Extract<Action, { type: 'auto_reply' }>): Promise<void>;
}

export interface ApplyResult {
  applied: Action['type'][];
  skipped: { type: Action['type']; reason: string }[];
}

/**
 * Applique les actions d'un message : drapeaux et libellés d'abord, puis transfert / réponse
 * automatique, et enfin UN seul déplacement (le premier demandé), pour ne pas perdre la trace
 * du message avant d'avoir tout appliqué.
 */
export async function applyActions(
  client: ImapFlow,
  ref: MessageRef,
  actions: Action[],
  effects: SideEffects,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], skipped: [] };
  const add = new Set<string>();
  const remove = new Set<string>();
  let seen = false;
  let flagged = false;
  for (const action of actions) {
    if (action.type === 'add_label') add.add(action.label);
    if (action.type === 'remove_label') remove.add(action.label);
    if (action.type === 'mark_read') seen = true;
    if (action.type === 'star') flagged = true;
  }
  if (add.size || remove.size || seen || flagged) {
    await updateFlags(client, ref, {
      addLabels: [...add],
      removeLabels: [...remove].filter((l) => !add.has(l)),
      ...(seen ? { seen: true } : {}),
      ...(flagged ? { flagged: true } : {}),
    });
    for (const action of actions) {
      if (['add_label', 'remove_label', 'mark_read', 'star'].includes(action.type))
        result.applied.push(action.type);
    }
  }

  for (const action of actions) {
    try {
      if (action.type === 'forward') {
        await effects.forward(action.to);
        result.applied.push('forward');
      } else if (action.type === 'auto_reply') {
        await effects.autoReply(action);
        result.applied.push('auto_reply');
      }
    } catch (error) {
      result.skipped.push({ type: action.type, reason: (error as Error).message || 'failed' });
    }
  }

  const relocation = actions.find(
    (a) => a.type === 'move' || a.type === 'archive' || a.type === 'delete',
  );
  if (relocation) {
    try {
      if (relocation.type === 'move') await moveMessage(client, ref, relocation.folder);
      if (relocation.type === 'archive')
        await moveMessage(client, ref, await specialFolder(client, '\\Archive'));
      if (relocation.type === 'delete') await deleteMessage(client, ref);
      result.applied.push(relocation.type);
    } catch (error) {
      result.skipped.push({ type: relocation.type, reason: (error as Error).message || 'failed' });
    }
  }
  return result;
}
