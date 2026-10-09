import type { Readable } from 'node:stream';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlow,
  MessageAddressObject,
  MessageStructureObject,
  SearchObject,
} from 'imapflow';

/**
 * Opérations de lecture sur une boîte IMAP. Le serveur IMAP reste la source de vérité :
 * rien n'est stocké durablement par Plume.
 */

export interface Folder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  total: number;
  unseen: number;
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageRef {
  folder: string;
  uidValidity: string;
  uid: number;
}

export interface AttachmentInfo {
  part: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface MessageSummary {
  ref: MessageRef;
  subject: string;
  from: Address[];
  to: Address[];
  date: string | null;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  /** Brouillon (drapeau \\Draft). */
  draft: boolean;
  keywords: string[];
  hasAttachments: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: Address[];
  /** Copie cachée : présente seulement dans les brouillons (jamais dans un message reçu). */
  bcc: Address[];
  replyTo: Address[];
  messageId: string | null;
  inReplyTo: string | null;
  attachments: AttachmentInfo[];
  htmlPart: string | null;
  textPart: string | null;
}

export type ListFilter = 'all' | 'unseen' | 'flagged' | 'attachments';

/** Position dans la liste : date de réception (ms) et UID du dernier message affiché. */
export interface ListPosition {
  date: number;
  uid: number;
}

export interface ListOptions {
  folder: string;
  filter: ListFilter;
  /** Recherche : tous les mots doivent figurer (voir `searchTerms`). */
  query?: string;
  /** Libellé (mot-clé IMAP) : restreint la liste aux messages qui le portent. */
  label?: string;
  /** Position de la page suivante : sous ce message dans l'ordre (date décroissante, UID). */
  before?: ListPosition;
  uidValidity?: string;
  limit: number;
}

export interface ListResult {
  uidValidity: string;
  messages: MessageSummary[];
  /** Position à partir de laquelle charger la page suivante, ou null s'il n'y en a plus. */
  nextBefore: ListPosition | null;
  total: number;
}

export class MailboxError extends Error {
  constructor(
    readonly code:
      'folder_not_found' | 'message_not_found' | 'part_not_found' | 'stale_cursor' | 'too_large',
  ) {
    super(code);
    this.name = 'MailboxError';
  }
}

const SYSTEM_FLAGS = new Set([
  '\\seen',
  '\\answered',
  '\\flagged',
  '\\deleted',
  '\\draft',
  '\\recent',
]);
/** Nombre maximal de messages examinés par requête pour le filtre « pièces jointes ». */
const MAX_SCAN = 500;
/** Nombre maximal de termes de recherche (une commande SEARCH par terme). */
const MAX_SEARCH_TERMS = 8;

/**
 * Termes d'une recherche : les mots séparés par des espaces, une « expression entre guillemets »
 * restant d'un seul tenant. Chaque terme est cherché séparément (IMAP SEARCH TEXT cherche une
 * sous-chaîne : « jean budget » ne trouverait que ces deux mots côte à côte).
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, MAX_SEARCH_TERMS);
}
const FETCH_QUERY = {
  uid: true,
  envelope: true,
  flags: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
} as const;

const FALLBACK_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
  headers: ['from', 'to', 'cc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to'],
};

/** Analyse un bloc d'en-têtes RFC 5322 (repliement, noms en minuscules). */
export function parseHeaders(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    (out[name] ??= []).push(
      line
        .slice(colon + 1)
        .trim()
        .slice(0, 2000),
    );
  }
  return out;
}

/** Décode les mots encodés RFC 2047 (« =?UTF-8?Q?…?= », « =?ISO-8859-1?B?…?= »). */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, '$1')
    .replace(
      /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g,
      (word, charset: string, kind: string, text: string) => {
        try {
          const bytes =
            kind.toUpperCase() === 'B'
              ? Buffer.from(text, 'base64')
              : decodeQuotedPrintable(Buffer.from(text.replace(/_/g, ' '), 'latin1'));
          return decodeCharset(bytes, charset.split('*')[0] ?? 'utf-8');
        } catch {
          return word;
        }
      },
    );
}

function headerAddresses(value: string | undefined): MessageAddressObject[] {
  if (!value) return [];
  const flatten = (list: AddressEntry[]): MessageAddressObject[] =>
    list.flatMap((a) =>
      a.group ? flatten(a.group) : [{ name: decodeWords(a.name ?? ''), address: a.address ?? '' }],
    );
  return flatten(addressparser(value) as AddressEntry[]);
}

interface AddressEntry {
  name?: string;
  address?: string;
  group?: AddressEntry[];
}

/**
 * Repli quand le serveur renvoie une ENVELOPE inexploitable (ImapFlow ignore alors le message) :
 * l'enveloppe est reconstruite à partir des en-têtes bruts, pour ne jamais masquer un message.
 */
function withSyntheticEnvelope(msg: FetchMessageObject): FetchMessageObject {
  const h = parseHeaders(msg.headers?.toString('utf8') ?? '');
  const date = h.date?.[0] ? new Date(h.date[0]) : undefined;
  return {
    ...msg,
    envelope: {
      subject: decodeWords(h.subject?.[0] ?? ''),
      from: headerAddresses(h.from?.[0]),
      to: headerAddresses(h.to?.join(', ')),
      cc: headerAddresses(h.cc?.join(', ')),
      replyTo: headerAddresses(h['reply-to']?.[0]),
      messageId: h['message-id']?.[0],
      inReplyTo: h['in-reply-to']?.[0],
      date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    },
  };
}

/** Récupère les messages demandés, avec repli pour ceux que la requête ENVELOPE a perdus. */
async function fetchSummaries(client: ImapFlow, uids: number[]): Promise<FetchMessageObject[]> {
  const fetched: FetchMessageObject[] = [];
  for await (const msg of client.fetch(uids.join(','), FETCH_QUERY, { uid: true })) {
    fetched.push(msg);
  }
  const seen = new Set(fetched.map((m) => m.uid));
  const missing = uids.filter((uid) => !seen.has(uid));
  if (missing.length > 0) {
    for await (const msg of client.fetch(missing.join(','), FALLBACK_QUERY, { uid: true })) {
      fetched.push(withSyntheticEnvelope(msg));
    }
  }
  return fetched;
}

function addresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? [])
    .filter((a) => a.address || a.name)
    .slice(0, 100)
    .map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));
}

function decodeParam(value: string | undefined): string {
  return value ?? '';
}

/** Parcourt la structure MIME pour lister pièces jointes et parties texte. */
export function analyzeStructure(root: MessageStructureObject | undefined): {
  attachments: AttachmentInfo[];
  htmlPart: string | null;
  textPart: string | null;
  sizes: Map<string, number>;
  encodings: Map<string, { encoding: string; charset: string }>;
} {
  const attachments: AttachmentInfo[] = [];
  const sizes = new Map<string, number>();
  const encodings = new Map<string, { encoding: string; charset: string }>();
  let htmlPart: string | null = null;
  let textPart: string | null = null;

  const visit = (node: MessageStructureObject, depth: number) => {
    if (depth > 20) return;
    const type = (node.type ?? '').toLowerCase();
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    const part = node.part ?? '1';
    sizes.set(part, node.size ?? 0);
    encodings.set(part, {
      encoding: (node.encoding ?? '7bit').toLowerCase(),
      charset: (node.parameters?.charset ?? 'utf-8').toLowerCase(),
    });
    const disposition = (node.disposition ?? '').toLowerCase();
    const filename = decodeParam(node.dispositionParameters?.filename ?? node.parameters?.name);
    const isText = type === 'text/html' || type === 'text/plain';
    if (isText && disposition !== 'attachment' && !filename) {
      if (type === 'text/html' && htmlPart === null) htmlPart = part;
      if (type === 'text/plain' && textPart === null) textPart = part;
      return;
    }
    if (type.startsWith('multipart/')) return;
    attachments.push({
      part,
      filename: filename || (type === 'message/rfc822' ? 'message.eml' : 'piece-jointe'),
      contentType: type || 'application/octet-stream',
      size: node.size ?? 0,
      contentId: node.id ? node.id.replace(/^<|>$/g, '') : null,
      inline: disposition === 'inline' || (!disposition && Boolean(node.id)),
    });
  };
  if (root) visit(root, 0);
  return { attachments, htmlPart, textPart, sizes, encodings };
}

function summarize(folder: string, uidValidity: string, msg: FetchMessageObject): MessageSummary {
  const flags = [...(msg.flags ?? new Set<string>())];
  const lower = new Set(flags.map((f) => f.toLowerCase()));
  const { attachments } = analyzeStructure(msg.bodyStructure);
  const envelope = msg.envelope;
  const date = envelope?.date ?? msg.internalDate;
  return {
    ref: { folder, uidValidity, uid: msg.uid },
    subject: envelope?.subject ?? '',
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    date: date ? new Date(date).toISOString() : null,
    size: msg.size ?? 0,
    seen: lower.has('\\seen'),
    flagged: lower.has('\\flagged'),
    answered: lower.has('\\answered'),
    draft: lower.has('\\draft'),
    keywords: flags.filter((f) => !SYSTEM_FLAGS.has(f.toLowerCase()) && !f.startsWith('\\')),
    hasAttachments: attachments.some((a) => !a.inline),
  };
}

/**
 * Dossiers de la boîte. Avec `counts: false`, pas de commande STATUS par dossier (compteurs à
 * zéro) : suffisant pour vérifier une existence ou trouver un usage spécial, et bien plus rapide.
 */
export async function listFolders(
  client: ImapFlow,
  options: { counts: boolean } = { counts: true },
): Promise<Folder[]> {
  const list = await client.list(
    options.counts ? { statusQuery: { messages: true, unseen: true } } : {},
  );
  return list
    .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
    .map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter,
      specialUse: f.specialUse ?? (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null),
      total: f.status?.messages ?? 0,
      unseen: f.status?.unseen ?? 0,
    }));
}

async function withLock<T>(
  client: ImapFlow,
  folder: string,
  _readOnly: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  let lock;
  try {
    // Toujours en lecture-écriture (SELECT) : alterner EXAMINE et SELECT forcerait une nouvelle
    // sélection de la boîte à chaque requête. Les lectures utilisent BODY.PEEK (aucun effet sur
    // \Seen) ; seules les actions explicites modifient la boîte.
    lock = await client.getMailboxLock(folder);
  } catch (error) {
    const err = error as { mailboxMissing?: boolean; responseStatus?: string };
    if (err.mailboxMissing || err.responseStatus === 'NO')
      throw new MailboxError('folder_not_found');
    throw error;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

function currentUidValidity(client: ImapFlow): string {
  const mailbox = client.mailbox;
  return mailbox ? String(mailbox.uidValidity) : '0';
}

/**
 * Dates de réception (INTERNALDATE) par connexion, dossier et UIDVALIDITY : lues une fois par
 * message puis réutilisées, pour trier sans relire toute la boîte à chaque page. La date de
 * réception est conservée par MOVE/COPY : un message archivé garde sa place chronologique.
 */
const arrivalCache = new WeakMap<ImapFlow, Map<string, Map<number, number>>>();
const MAX_CACHED_DATES = 250_000;

/** Ensemble d'UID compact pour IMAP (« 1:5,8,10:12 »). */
function uidSet(uids: number[]): string {
  const sorted = [...uids].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const uid of sorted.slice(1)) {
    if (uid === prev + 1) {
      prev = uid;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    start = prev = uid;
  }
  parts.push(start === prev ? String(start) : `${start}:${prev}`);
  return parts.join(',');
}

async function arrivalDates(
  client: ImapFlow,
  folder: string,
  uidValidity: string,
  uids: number[],
): Promise<Map<number, number>> {
  let folders = arrivalCache.get(client);
  if (!folders) {
    folders = new Map();
    arrivalCache.set(client, folders);
  }
  const key = `${uidValidity}:${folder}`;
  let dates = folders.get(key);
  if (!dates || dates.size > MAX_CACHED_DATES) {
    dates = new Map();
    folders.set(key, dates);
  }
  const missing = uids.filter((uid) => !dates.has(uid));
  if (missing.length > 0) {
    for await (const msg of client.fetch(
      uidSet(missing),
      { uid: true, internalDate: true },
      { uid: true },
    )) {
      const time = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
      dates.set(msg.uid, Number.isNaN(time) ? 0 : time);
    }
  }
  return dates;
}

/** Ordre de la liste : plus récent d'abord (date de réception), puis UID décroissant. */
function compareArrival(dates: Map<number, number>) {
  return (a: number, b: number) => (dates.get(b) ?? 0) - (dates.get(a) ?? 0) || b - a;
}

export async function listMessages(client: ImapFlow, options: ListOptions): Promise<ListResult> {
  return withLock(client, options.folder, true, async () => {
    const uidValidity = currentUidValidity(client);
    if (options.uidValidity && options.uidValidity !== uidValidity) {
      throw new MailboxError('stale_cursor');
    }
    const criteria: SearchObject = { all: true };
    if (options.filter === 'unseen') criteria.seen = false;
    if (options.filter === 'flagged') criteria.flagged = true;
    if (options.label) criteria.keyword = options.label;
    const [first, ...others] = options.query ? searchTerms(options.query) : [];
    if (first) criteria.text = first;
    let found = (await client.search(criteria, { uid: true })) || [];
    // Termes suivants : chacun restreint les résultats précédents (tous les mots doivent figurer).
    for (const term of others) {
      if (found.length === 0) break;
      found = (await client.search({ uid: uidSet(found), text: term }, { uid: true })) || [];
    }
    const total = found.length;
    const dates =
      found.length > 0
        ? await arrivalDates(client, options.folder, uidValidity, found)
        : new Map<number, number>();
    const position = (uid: number): ListPosition => ({ date: dates.get(uid) ?? 0, uid });
    let uids = [...found].sort(compareArrival(dates));
    if (options.before !== undefined) {
      const before = options.before;
      uids = uids.filter((uid) => {
        const date = dates.get(uid) ?? 0;
        return date < before.date || (date === before.date && uid < before.uid);
      });
    }
    const rank = new Map(uids.map((uid, i) => [uid, i]));

    const messages: MessageSummary[] = [];
    let scanned = 0;
    let index = 0;
    while (messages.length < options.limit && index < uids.length && scanned < MAX_SCAN) {
      const batch = uids.slice(index, index + Math.max(options.limit, 20));
      index += batch.length;
      scanned += batch.length;
      const fetched = await fetchSummaries(client, batch);
      fetched.sort((a, b) => (rank.get(a.uid) ?? 0) - (rank.get(b.uid) ?? 0));
      for (const msg of fetched) {
        const summary = summarize(options.folder, uidValidity, msg);
        if (options.filter === 'attachments' && !summary.hasAttachments) continue;
        messages.push(summary);
        if (messages.length === options.limit) break;
      }
    }
    let nextBefore: ListPosition | null = null;
    const last = messages.at(-1);
    if (messages.length === options.limit && last) {
      // Page pleine : la suite commence sous le dernier message renvoyé.
      const lastRank = rank.get(last.ref.uid) ?? uids.length;
      nextBefore = lastRank < uids.length - 1 ? position(last.ref.uid) : null;
    } else if (index < uids.length) {
      // Limite d'examen atteinte (filtre « pièces jointes ») : reprendre sous le dernier examiné.
      const examined = uids[index - 1];
      nextBefore = examined !== undefined ? position(examined) : null;
    }
    return {
      uidValidity,
      messages,
      nextBefore,
      total,
    };
  });
}

function checkRef(client: ImapFlow, ref: MessageRef) {
  if (currentUidValidity(client) !== ref.uidValidity) throw new MailboxError('message_not_found');
}

/** Décodage quoted-printable (RFC 2045), y compris les fins de ligne « douces ». */
export function decodeQuotedPrintable(input: Buffer): Buffer {
  const text = input.toString('latin1').replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Convertit un texte vers UTF-8 ; un jeu de caractères inconnu est lu comme windows-1252. */
export function decodeCharset(input: Buffer, charset: string): string {
  const label = charset.trim().toLowerCase();
  if (label === 'utf-8' || label === 'utf8' || label === 'us-ascii' || label === 'ascii') {
    return input.toString('utf8');
  }
  try {
    return new TextDecoder(label).decode(input);
  } catch {
    return new TextDecoder('windows-1252').decode(input);
  }
}

async function readStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      stream.destroy();
      throw new MailboxError('too_large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface MessageContent {
  detail: MessageDetail;
  html: string | null;
  text: string | null;
}

/** Charge un message (en-têtes, structure, corps). Le marque comme lu si demandé. */
export async function getMessage(
  client: ImapFlow,
  ref: MessageRef,
  options: { markSeen: boolean; maxBodyBytes: number },
): Promise<MessageContent> {
  return withLock(client, ref.folder, !options.markSeen, async () => {
    checkRef(client, ref);
    const [msg] = await fetchSummaries(client, [ref.uid]);
    if (!msg) throw new MailboxError('message_not_found');
    const summary = summarize(ref.folder, ref.uidValidity, msg);
    const structure = analyzeStructure(msg.bodyStructure);
    const envelope = msg.envelope;

    const download = async (part: string | null) => {
      if (!part) return null;
      // Taille encodée annoncée par le serveur : refus avant tout transfert.
      if ((structure.sizes.get(part) ?? 0) > options.maxBodyBytes * 1.4) {
        throw new MailboxError('too_large');
      }
      // ImapFlow tronque silencieusement à maxBytes : on demande un octet de plus pour détecter
      // un dépassement plutôt que d'afficher un corps tronqué.
      const { content, meta } = await client.download(String(ref.uid), part, {
        uid: true,
        maxBytes: options.maxBodyBytes + 1,
      });
      let raw = await readStream(content, options.maxBodyBytes);
      // Repli : si le serveur n'a pas fourni les en-têtes MIME de la partie, ImapFlow renvoie le
      // contenu encore encodé ; la BODYSTRUCTURE indique alors l'encodage et le jeu de caractères.
      const declared = structure.encodings.get(part);
      if (!meta.encoding && declared) {
        if (declared.encoding === 'quoted-printable') raw = decodeQuotedPrintable(raw);
        if (declared.encoding === 'base64') raw = Buffer.from(raw.toString('latin1'), 'base64');
      }
      return meta.charset ? raw.toString('utf8') : decodeCharset(raw, declared?.charset ?? 'utf-8');
    };
    const html = await download(structure.htmlPart);
    const text = html === null ? await download(structure.textPart) : null;

    if (options.markSeen && !summary.seen) {
      await client.messageFlagsAdd(String(ref.uid), ['\\Seen'], { uid: true });
      summary.seen = true;
    }
    return {
      detail: {
        ...summary,
        cc: addresses(envelope?.cc),
        bcc: addresses(envelope?.bcc),
        replyTo: addresses(envelope?.replyTo),
        messageId: envelope?.messageId ?? null,
        inReplyTo: envelope?.inReplyTo ?? null,
        attachments: structure.attachments,
        htmlPart: structure.htmlPart,
        textPart: structure.textPart,
      },
      html,
      text,
    };
  });
}

/** Liste les pièces jointes d'un message (sans télécharger le corps). */
export async function getAttachments(client: ImapFlow, ref: MessageRef): Promise<AttachmentInfo[]> {
  return withLock(client, ref.folder, true, async () => {
    checkRef(client, ref);
    const msg = await client.fetchOne(
      String(ref.uid),
      { uid: true, bodyStructure: true },
      { uid: true },
    );
    if (!msg) throw new MailboxError('message_not_found');
    return analyzeStructure(msg.bodyStructure).attachments;
  });
}

/**
 * Télécharge une partie MIME (pièce jointe). Le contenu est entièrement lu en mémoire sous la
 * limite de taille : le verrou de la boîte est libéré avant l'envoi au client.
 */
export async function downloadPart(
  client: ImapFlow,
  ref: MessageRef,
  part: string,
  maxBytes: number,
): Promise<{ info: AttachmentInfo; content: Buffer }> {
  return withLock(client, ref.folder, true, async () => {
    checkRef(client, ref);
    const msg = await client.fetchOne(
      String(ref.uid),
      { uid: true, bodyStructure: true },
      { uid: true },
    );
    if (!msg) throw new MailboxError('message_not_found');
    const structure = analyzeStructure(msg.bodyStructure);
    const info = structure.attachments.find((a) => a.part === part);
    if (!info) throw new MailboxError('part_not_found');
    if (info.size > maxBytes * 1.4) throw new MailboxError('too_large'); // taille encodée base64
    const { content, meta } = await client.download(String(ref.uid), part, {
      uid: true,
      maxBytes: maxBytes + 1,
    });
    let raw = await readStream(content, maxBytes);
    const declared = structure.encodings.get(part);
    if (!meta.encoding && declared) {
      // Même repli que pour le corps (en-têtes MIME de la partie absents).
      if (declared.encoding === 'quoted-printable') raw = decodeQuotedPrintable(raw);
      if (declared.encoding === 'base64') raw = Buffer.from(raw.toString('latin1'), 'base64');
    }
    return { info, content: raw };
  });
}

const MESSAGE_ID_RE = /^<[^<>\s]{1,250}>$/;

/** En-têtes nécessaires pour répondre (fils de discussion), lus sur le serveur IMAP. */
export async function getReplyInfo(
  client: ImapFlow,
  ref: MessageRef,
): Promise<{ messageId: string | null; references: string[] }> {
  return withLock(client, ref.folder, true, async () => {
    checkRef(client, ref);
    const msg = await client.fetchOne(
      String(ref.uid),
      { uid: true, envelope: true, headers: ['references'] },
      { uid: true },
    );
    if (!msg) throw new MailboxError('message_not_found');
    const raw = (msg.headers?.toString('utf8') ?? '')
      .replace(/^references:/i, '')
      .replace(/\r?\n[ \t]+/g, ' ');
    const references = raw
      .split(/\s+/)
      .filter((token) => MESSAGE_ID_RE.test(token))
      .slice(-20);
    const messageId = msg.envelope?.messageId;
    return { messageId: messageId && MESSAGE_ID_RE.test(messageId) ? messageId : null, references };
  });
}

/** Nombre maximal de messages récents examinés par dossier pour recenser les libellés. */
const LABEL_SCAN = 1000;

/** Libellé = mot-clé IMAP : un « atom » ASCII sans caractère spécial ni préfixe « \ ». */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/;

export function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label) && !/^(seen|answered|flagged|deleted|draft|recent)$/i.test(label);
}

/**
 * Libellés (mots-clés IMAP) utilisés dans les dossiers donnés : mots-clés déclarés par la boîte
 * (réponse FLAGS) et ceux des messages récents (FETCH FLAGS, peu coûteux).
 */
export async function listLabels(client: ImapFlow, folders: string[]): Promise<string[]> {
  const labels = new Set<string>();
  const isKeyword = (flag: string) =>
    !flag.startsWith('\\') && !SYSTEM_FLAGS.has(flag.toLowerCase());
  for (const folder of folders) {
    try {
      await withLock(client, folder, true, async () => {
        const exists = client.mailbox ? client.mailbox.exists : 0;
        if (exists === 0) return;
        const range = `${Math.max(1, exists - LABEL_SCAN + 1)}:*`;
        for await (const msg of client.fetch(range, { flags: true })) {
          for (const flag of msg.flags ?? []) if (isKeyword(flag)) labels.add(flag);
        }
        // Mots-clés déclarés par la boîte mais absents des messages récents : retenus seulement
        // s'ils sont encore portés par un message (un libellé supprimé reste souvent déclaré).
        for (const flag of client.mailbox ? client.mailbox.flags : []) {
          if (!isKeyword(flag) || labels.has(flag) || !isValidLabel(flag)) continue;
          const found = await client.search({ keyword: flag }, { uid: true });
          if (found && found.length > 0) labels.add(flag);
        }
      });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b, 'fr'));
}

/**
 * Supprime un libellé : le mot-clé est retiré de tous les messages qui le portent, dans chacun
 * des dossiers donnés. Renvoie le nombre de messages modifiés.
 */
export async function deleteLabel(
  client: ImapFlow,
  label: string,
  folders: string[],
): Promise<number> {
  if (!isValidLabel(label)) return 0;
  let changed = 0;
  for (const folder of folders) {
    try {
      await withLock(client, folder, false, async () => {
        const uids = await client.search({ keyword: label }, { uid: true });
        if (!uids || uids.length === 0) return;
        await client.messageFlagsRemove(uids.join(','), [label], { uid: true });
        changed += uids.length;
      });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
    }
  }
  return changed;
}
