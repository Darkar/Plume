import { describe, expect, it } from 'vitest';
import {
  buildMime,
  headerSafe,
  htmlToText,
  isValidRecipient,
  sanitizeOutgoingHtml,
  type OutgoingMessage,
} from '../src/compose.js';
import { isValidLabel } from '../src/mailbox.js';
import { sanitizeEmailHtml } from '../src/sanitize.js';

const base: OutgoingMessage = {
  from: { name: 'Sacha', address: 'sacha@exemple.com' },
  to: [{ name: '', address: 'alice@exemple.fr' }],
  cc: [],
  bcc: [],
  subject: 'Bonjour',
  html: '<p>Salut</p>',
  attachments: [],
};

/** En-têtes du message brut (avant la première ligne vide). */
function headers(raw: Buffer): string[] {
  const text = raw.toString('utf8');
  return text.slice(0, text.indexOf('\r\n\r\n')).split('\r\n');
}

function headerNames(raw: Buffer): string[] {
  return headers(raw)
    .filter((line) => !/^\s/.test(line))
    .map((line) => line.split(':')[0]?.toLowerCase() ?? '');
}

describe('injection d’en-têtes SMTP', () => {
  it.each([
    ['sujet', { subject: 'Salut\r\nBcc: victime@evil.example' }],
    ['sujet (LF seul)', { subject: 'Salut\nX-Injected: 1' }],
    [
      'nom affiché',
      { from: { name: 'Sacha\r\nBcc: victime@evil.example', address: 'sacha@exemple.com' } },
    ],
    [
      'nom du destinataire',
      { to: [{ name: 'Alice\r\nX-Injected: oui', address: 'alice@exemple.fr' }] },
    ],
    [
      'nom de pièce jointe',
      {
        attachments: [
          {
            filename: 'a.txt\r\nX-Injected: 1',
            contentType: 'text/plain',
            content: Buffer.from('x'),
          },
        ],
      },
    ],
    [
      'type de pièce jointe',
      {
        attachments: [
          {
            filename: 'a.txt',
            contentType: 'text/plain\r\nX-Injected: 1',
            content: Buffer.from('x'),
          },
        ],
      },
    ],
    [
      'séparateurs Unicode',
      { subject: 'Salut\u{2028}Bcc: victime@evil.example\u{85}X-Injected: 1' },
    ],
  ])('neutralise un CRLF dans le %s', async (_name, patch) => {
    const raw = await buildMime({ ...base, ...(patch as Partial<OutgoingMessage>) });
    const names = headerNames(raw);
    expect(names).not.toContain('bcc');
    expect(names).not.toContain('x-injected');
    expect(raw.toString()).not.toMatch(/\r\n(Bcc|X-Injected):/i);
  });

  it('ne met jamais les destinataires en copie cachée dans les en-têtes', async () => {
    const raw = await buildMime({
      ...base,
      bcc: [{ name: 'Secret', address: 'cache@exemple.fr' }],
    });
    expect(raw.toString()).not.toContain('cache@exemple.fr');
  });

  it('pose les en-têtes de réponse fournis par le serveur', async () => {
    const raw = await buildMime({
      ...base,
      inReplyTo: '<orig@exemple.fr>',
      references: ['<a@exemple.fr>', '<orig@exemple.fr>'],
    });
    const text = headers(raw).join('\n');
    expect(text).toContain('In-Reply-To: <orig@exemple.fr>');
    expect(text).toMatch(/References: <a@exemple.fr>\s+<orig@exemple.fr>/);
  });

  it('headerSafe supprime les caractères de contrôle et tronque', () => {
    expect(headerSafe('a\r\nb\tc\u{0}d', 100)).toBe('a b c d');
    expect(headerSafe('x'.repeat(10), 4)).toBe('xxxx');
  });
});

describe('isValidRecipient', () => {
  it.each(['alice@exemple.fr', 'a.b+tag@sous.exemple.fr', "o'brien@exemple.ie"])(
    'accepte %s',
    (a) => {
      expect(isValidRecipient(a)).toBe(true);
    },
  );
  it.each([
    'alice',
    'alice@',
    '@exemple.fr',
    'alice@exemple',
    'a@b@exemple.fr',
    'alice@exemple.fr\r\nRCPT TO:<x@y.z>',
    'alice @exemple.fr',
    '<alice@exemple.fr>',
    'alice@exemple..fr',
    'alice@-exemple.fr',
    'alice@127.0.0.1',
    `${'a'.repeat(65)}@exemple.fr`,
    'alice@exemple.fr,bob@exemple.fr',
  ])('refuse %j', (a) => {
    expect(isValidRecipient(a)).toBe(false);
  });
});

describe('contenu sortant', () => {
  it('nettoie le HTML de l’éditeur', () => {
    const html = sanitizeOutgoingHtml(
      '<p style="color:red" onclick="x()">Hi <b>there</b></p><script>alert(1)</script><img src="https://t.example/p.gif"><a href="javascript:x()">j</a><a href="https://ok.example">ok</a>',
    );
    expect(html).toBe(
      '<p>Hi <b>there</b></p><a>j</a><a rel="noopener noreferrer" href="https://ok.example">ok</a>',
    );
  });

  it('produit une alternative texte', () => {
    expect(
      htmlToText('<p>Bonjour,</p><p>Voir <a href="https://x.example">ici</a><br>Merci</p>'),
    ).toBe('Bonjour,\nVoir ici <https://x.example>\nMerci');
  });

  it('ignore scripts, styles et en-tête (citation d’un document nettoyé)', () => {
    const doc = sanitizeEmailHtml('<style>p{color:red}</style><p>Test2</p>', {
      remoteImages: 'block',
    }).html;
    expect(doc).toContain('plume:body-height');
    expect(htmlToText(doc)).toBe('Test2');
  });
});

describe('isValidLabel', () => {
  it.each(['Factures', 'projet-2026', 'a.b_c+d'])('accepte %s', (l) =>
    expect(isValidLabel(l)).toBe(true),
  );
  it.each(['', 'avec espace', '\\Seen', 'Seen', 'deleted', 'a"b', 'é', 'x'.repeat(65), 'a)b'])(
    'refuse %j',
    (l) => expect(isValidLabel(l)).toBe(false),
  );
});
