import type { MessageRef } from '@plume/mail';

/**
 * Identifiants opaques transmis au client. Ils ne sont interprétés que dans la boîte IMAP de
 * l'utilisateur authentifié : un identifiant forgé ne donne accès à rien d'autre (pas d'IDOR).
 */

/** Numéro de partie MIME IMAP : « 1 », « 1.2 », « 2.1.3 »… (10 niveaux au plus). */
function isValidPart(part: string): boolean {
  const segments = part.split('.');
  return segments.length <= 10 && segments.every((s) => /^[1-9]\d{0,3}$/.test(s));
}
const MAX_ID_LENGTH = 1500;

function isSafeFolder(folder: unknown): folder is string {
  if (typeof folder !== 'string' || folder.length === 0 || folder.length > 500) return false;
  for (let i = 0; i < folder.length; i++) {
    const code = folder.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function encode(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(id: string): unknown[] | null {
  if (id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function encodeMessageId(ref: MessageRef): string {
  return encode([ref.folder, ref.uidValidity, ref.uid]);
}

export function decodeMessageId(id: string): MessageRef | null {
  const value = decode(id);
  if (!value || value.length !== 3) return null;
  const [folder, uidValidity, uid] = value;
  if (!isSafeFolder(folder)) return null;
  if (typeof uidValidity !== 'string' || !/^\d{1,20}$/.test(uidValidity)) return null;
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff)
    return null;
  return { folder, uidValidity, uid };
}

export function encodeAttachmentId(ref: MessageRef, part: string): string {
  return encode([ref.folder, ref.uidValidity, ref.uid, part]);
}

export function decodeAttachmentId(id: string): { ref: MessageRef; part: string } | null {
  const value = decode(id);
  if (!value || value.length !== 4) return null;
  const ref = decodeMessageId(encode(value.slice(0, 3)));
  const part = value[3];
  if (!ref || typeof part !== 'string' || !isValidPart(part)) return null;
  return { ref, part };
}

export function encodeCursor(uidValidity: string, before: { date: number; uid: number }): string {
  return encode([uidValidity, before.date, before.uid]);
}

/** Curseur de pagination : UIDVALIDITY et position (date de réception, UID) du dernier message. */
export function decodeCursor(
  cursor: string,
): { uidValidity: string; before: { date: number; uid: number } } | null {
  const value = decode(cursor);
  if (!value || value.length !== 3) return null;
  const [uidValidity, date, uid] = value;
  if (typeof uidValidity !== 'string' || !/^\d{1,20}$/.test(uidValidity)) return null;
  if (typeof date !== 'number' || !Number.isSafeInteger(date) || date < 0) return null;
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 1) return null;
  return { uidValidity, before: { date, uid } };
}

/**
 * Nettoie un nom de fichier fourni par l'expéditeur : aucun séparateur de chemin, caractère de
 * contrôle, « .. » ni nom réservé ; longueur limitée ; extension conservée.
 */
export function sanitizeFilename(input: string, fallback = 'piece-jointe'): string {
  let name = input.normalize('NFC');
  // Ne garde que le dernier segment d'un éventuel chemin.
  name = name.split(/[/\\]/).pop() ?? '';
  let out = '';
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue;
    if (code >= 0x200b && code <= 0x200f) continue; // espaces invisibles
    if (code >= 0x202a && code <= 0x202e) continue; // contrôles bidirectionnels (« exe.pdf »)
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += /[<>:"|?*]/.test(char) ? '_' : char;
  }
  out = out
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .replace(/\s+/g, ' ');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out)) out = `_${out}`;
  if (out.length > 150) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 10 ? out.slice(dot) : '';
    out = out.slice(0, 150 - ext.length) + ext;
  }
  return out || fallback;
}

/** En-tête Content-Disposition (RFC 6266) avec repli ASCII et nom UTF-8 encodé. */
export function contentDisposition(type: 'attachment' | 'inline', filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
