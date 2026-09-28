import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  decodeAttachmentId,
  decodeCursor,
  decodeMessageId,
  encodeAttachmentId,
  encodeCursor,
  encodeMessageId,
  sanitizeFilename,
} from '../src/lib/ids.js';
import { UrlSigner } from '../src/lib/signing.js';

const ref = { folder: 'INBOX/Factures é', uidValidity: '1695000000', uid: 42 };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('identifiants opaques', () => {
  it('aller-retour message, pièce jointe et curseur', () => {
    expect(decodeMessageId(encodeMessageId(ref))).toEqual(ref);
    expect(decodeAttachmentId(encodeAttachmentId(ref, '1.2.3'))).toEqual({ ref, part: '1.2.3' });
    expect(decodeCursor(encodeCursor('17', { date: 1_790_000_000_000, uid: 99 }))).toEqual({
      uidValidity: '17',
      before: { date: 1_790_000_000_000, uid: 99 },
    });
  });

  it.each([
    ['', 'vide'],
    ['!!!', 'caractères invalides'],
    [b64({ folder: 'INBOX' }), 'objet'],
    [b64(['INBOX', '1']), 'longueur'],
    [b64(['', '1', 1]), 'dossier vide'],
    [b64(['IN\nBOX', '1', 1]), 'dossier avec saut de ligne'],
    [b64(['INBOX', '1', 0]), 'UID nul'],
    [b64(['INBOX', '1', 1.5]), 'UID décimal'],
    [b64(['INBOX', '1', 2 ** 40]), 'UID trop grand'],
    [b64(['INBOX', 'abc', 1]), 'UIDVALIDITY non numérique'],
    ['A'.repeat(2000), 'trop long'],
  ])('rejette un identifiant de message invalide (%s / %s)', (id) => {
    expect(decodeMessageId(id)).toBeNull();
  });

  it.each([
    [b64(['17', 99]), 'ancien format sans date'],
    [b64(['17', -1, 99]), 'date négative'],
    [b64(['17', 1.5, 99]), 'date décimale'],
    [b64(['17', 1, 0]), 'UID nul'],
    [b64(['x', 1, 1]), 'UIDVALIDITY non numérique'],
  ])('rejette un curseur invalide (%s / %s)', (cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });

  it.each(['1;DELETE', '1..2', '', '1.', 'HEADER', '1'.repeat(10)])(
    'rejette la partie %j',
    (part) => {
      expect(decodeAttachmentId(b64(['INBOX', '1', 1, part]))).toBeNull();
    },
  );
});

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'],
    ['a\u{0}b.pdf', 'ab.pdf'],
    ['facture.pdf\u{202e}exe.txt', 'facture.pdfexe.txt'],
    ['rapport.pdf.exe', 'rapport.pdf.exe'],
    ['  .caché  ', 'caché'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['...', 'piece-jointe'],
    ['', 'piece-jointe'],
    ['résumé été.pdf', 'résumé été.pdf'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('tronque en conservant l’extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.pdf`);
    expect(name.length).toBe(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('construit un Content-Disposition sans injection', () => {
    expect(contentDisposition('attachment', 'a"b\r\nSet-Cookie: x=1.pdf')).toBe(
      'attachment; filename="a_bSet-Cookie_ x=1.pdf"; filename*=UTF-8\'\'a_bSet-Cookie_%20x%3D1.pdf',
    );
    expect(contentDisposition('inline', 'été.pdf')).toBe(
      'inline; filename="_t_.pdf"; filename*=UTF-8\'\'%C3%A9t%C3%A9.pdf',
    );
  });
});

describe('UrlSigner', () => {
  const signer = new UrlSigner(randomBytes(32));
  const now = 1_700_000_000_000;

  it('vérifie une signature valide et refuse toute modification', () => {
    const sig = signer.sign('image-proxy', ['https://a.example/x.png'], now + 1000);
    expect(signer.verify('image-proxy', ['https://a.example/x.png'], now + 1000, sig, now)).toBe(
      true,
    );
    expect(signer.verify('image-proxy', ['https://a.example/y.png'], now + 1000, sig, now)).toBe(
      false,
    );
    expect(signer.verify('attachment', ['https://a.example/x.png'], now + 1000, sig, now)).toBe(
      false,
    );
    expect(signer.verify('image-proxy', ['https://a.example/x.png'], now + 2000, sig, now)).toBe(
      false,
    );
  });

  it('refuse une signature expirée ou d’une autre clé', () => {
    const sig = signer.sign('s', ['v'], now - 1);
    expect(signer.verify('s', ['v'], now - 1, sig, now)).toBe(false);
    const other = new UrlSigner(randomBytes(32)).sign('s', ['v'], now + 1000);
    expect(signer.verify('s', ['v'], now + 1000, other, now)).toBe(false);
  });

  it('refuse l’ambiguïté de concaténation', () => {
    const sig = signer.sign('s', ['a', 'b'], now + 1000);
    expect(signer.verify('s', ['a\nb'], now + 1000, sig, now)).toBe(false);
    expect(signer.verify('s', ['ab'], now + 1000, sig, now)).toBe(false);
  });
});
