import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { createTransport } from 'nodemailer';
import { tlsOptions, type ServerTarget } from './server.js';

/**
 * Composition et envoi. Les en-têtes sont construits exclusivement par Nodemailer à partir de
 * champs validés : aucun en-tête libre n'est accepté depuis le client (anti-injection CRLF).
 */

const { window } = new JSDOM('');
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

const OUTGOING_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'u',
  'ul',
];

/** Nettoie le HTML produit par l'éditeur (ou une signature) avant envoi ou enregistrement. */
export function sanitizeOutgoingHtml(html: string): string {
  const clean = String(
    purify.sanitize(html, {
      ALLOWED_TAGS: OUTGOING_TAGS,
      ALLOWED_ATTR: ['href'],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    }),
  );
  // Liens des messages envoyés : ouverture sûre chez le destinataire.
  return clean.replace(/<a href=/g, '<a rel="noopener noreferrer" href=');
}

/** Version texte d'un HTML (alternative text/plain du message). */
export function htmlToText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`);
  const { document } = dom.window;
  // Contenu jamais affiché : scripts (dont celui de mesure de hauteur du document isolé),
  // feuilles de style, métadonnées.
  for (const hidden of document.querySelectorAll(
    'script, style, noscript, template, head, title',
  )) {
    hidden.remove();
  }
  for (const br of document.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of document.querySelectorAll('p, div, li, h1, h2, h3, blockquote, pre, tr')) {
    block.append('\n');
  }
  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    if (href && href !== link.textContent) link.append(` <${href}>`);
  }
  const text = (document.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  dom.window.close();
  return text;
}

export interface Recipient {
  name: string;
  address: string;
}

const ATOM_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL_CHARS_RE = /^[A-Za-z0-9-]+$/;

function isValidDomainLabel(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    LABEL_CHARS_RE.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

/** Adresse de destinataire : syntaxe stricte (dot-atom ASCII), sans caractère de contrôle. */
export function isValidRecipient(address: string): boolean {
  if (address.length > 254) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || address.indexOf('@') !== at) return false;
  const local = address.slice(0, at);
  const labels = address.slice(at + 1).split('.');
  if (
    local.length > 64 ||
    !local.split('.').every((atom) => atom.length > 0 && ATOM_RE.test(atom))
  ) {
    return false;
  }
  return (
    labels.length >= 2 && labels.every(isValidDomainLabel) && !/^\d+$/.test(labels.at(-1) ?? '')
  );
}

/** Supprime tout caractère de contrôle (dont CR/LF) d'une valeur destinée à un en-tête. */
export function headerSafe(value: string, maxLength: number): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x80 && code < 0xa0) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      out += ' ';
    } else {
      out += char;
    }
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: Recipient;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string[];
  attachments: OutgoingAttachment[];
  /** Brouillon : la copie cachée est conservée dans l'en-tête (le message n'est pas envoyé). */
  keepBcc?: boolean;
  /** Partie iCalendar (réponse à une invitation, RFC 6047) jointe en alternative text/calendar. */
  calendar?: { method: 'REPLY'; content: string };
  /** Marqueurs internes (moteur de règles) : jamais exposés à l'API. */
  automatic?: 'auto-replied' | 'forwarded' | 'digest';
}

/** Construit le message MIME brut (envoyé tel quel puis copié dans « Envoyés »). */
export async function buildMime(message: OutgoingMessage): Promise<Buffer> {
  const html = sanitizeOutgoingHtml(message.html);
  const clean = (r: Recipient) => ({ name: headerSafe(r.name, 100), address: r.address });
  const composer = new MailComposer({
    from: clean(message.from),
    to: message.to.map(clean),
    cc: message.cc.map(clean),
    // Les destinataires en copie cachée ne figurent que dans l'enveloppe SMTP, sauf dans un
    // brouillon enregistré (jamais envoyé tel quel).
    ...(message.keepBcc ? { bcc: message.bcc.map(clean) } : {}),
    subject: headerSafe(message.subject, 500),
    html,
    text: htmlToText(html),
    inReplyTo: message.inReplyTo,
    references: message.references,
    ...(message.calendar
      ? { icalEvent: { method: message.calendar.method, content: message.calendar.content } }
      : {}),
    attachments: message.attachments.map((a) => ({
      filename: headerSafe(a.filename, 150) || 'piece-jointe',
      contentType: /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.contentType)
        ? a.contentType
        : 'application/octet-stream',
      content: a.content,
    })),
    headers: {
      'X-Mailer': 'Plume',
      // RFC 3834 : signale les messages automatiques ; anti-boucle pour les transferts.
      ...(message.automatic
        ? {
            'Auto-Submitted':
              message.automatic === 'auto-replied' ? 'auto-replied' : 'auto-generated',
          }
        : {}),
      ...(message.automatic === 'forwarded' ? { 'X-Plume-Forwarded': '1' } : {}),
    },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const node = composer.compile();
  // Nodemailer retire l'en-tête Bcc à la construction, sauf demande explicite.
  if (message.keepBcc) node.keepBcc = true;
  return node.build();
}

export interface SmtpCredentials {
  target: ServerTarget;
  user: string;
  pass: string;
}

/** Envoie un message brut par SMTP (TLS implicite ou STARTTLS obligatoire). */
export async function sendRaw(
  smtp: SmtpCredentials,
  envelope: { from: string; to: string[] },
  raw: Buffer,
): Promise<void> {
  const transport = createTransport({
    host: smtp.target.host,
    port: smtp.target.port,
    secure: smtp.target.security === 'tls',
    requireTLS: smtp.target.security === 'starttls',
    ignoreTLS: false,
    tls: tlsOptions(smtp.target),
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({ envelope, raw });
  } finally {
    transport.close();
  }
}
