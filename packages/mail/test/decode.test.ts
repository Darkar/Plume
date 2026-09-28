import { describe, expect, it } from 'vitest';
import { analyzeStructure, decodeCharset, decodeQuotedPrintable } from '../src/mailbox.js';

describe('décodage de repli', () => {
  it('quoted-printable', () => {
    expect(decodeQuotedPrintable(Buffer.from('=C3=A9t=C3=A9 =3D ok=\r\nsuite')).toString()).toBe(
      'été = oksuite',
    );
    expect(decodeQuotedPrintable(Buffer.from('=ZZ reste')).toString()).toBe('=ZZ reste');
  });

  it('jeux de caractères', () => {
    expect(decodeCharset(Buffer.from([0xe9, 0x74, 0xe9]), 'iso-8859-1')).toBe('été');
    expect(decodeCharset(Buffer.from([0x80]), 'windows-1252')).toBe('€');
    expect(decodeCharset(Buffer.from('été'), 'UTF-8')).toBe('été');
    expect(decodeCharset(Buffer.from([0xe9]), 'charset-inconnu')).toBe('é');
  });
});

describe('analyzeStructure', () => {
  it('distingue corps, pièces jointes et images intégrées', () => {
    const result = analyzeStructure({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            {
              part: '1.1',
              type: 'text/plain',
              encoding: 'quoted-printable',
              parameters: { charset: 'ISO-8859-1' },
            },
            { part: '1.2', type: 'text/html', encoding: 'base64' },
          ],
        },
        { part: '2', type: 'image/png', id: '<logo@x>', size: 10 },
        {
          part: '3',
          type: 'text/plain',
          disposition: 'attachment',
          dispositionParameters: { filename: 'notes.txt' },
        },
        { part: '4', type: 'message/rfc822' },
      ],
    });
    expect(result.textPart).toBe('1.1');
    expect(result.htmlPart).toBe('1.2');
    expect(result.encodings.get('1.1')).toEqual({
      encoding: 'quoted-printable',
      charset: 'iso-8859-1',
    });
    expect(result.attachments.map((a) => [a.part, a.filename, a.inline, a.contentId])).toEqual([
      ['2', 'piece-jointe', true, 'logo@x'],
      ['3', 'notes.txt', false, null],
      ['4', 'message.eml', false, null],
    ]);
  });
});

describe('decodeWords', () => {
  it('décode les mots encodés B et Q, y compris enchaînés', async () => {
    const { decodeWords } = await import('../src/mailbox.js');
    expect(decodeWords('=?UTF-8?Q?Exp=C3=A9diteur?= <a@b.fr>')).toBe('Expéditeur <a@b.fr>');
    expect(decodeWords('=?ISO-8859-1?B?6XTp?=')).toBe('été');
    expect(decodeWords('=?UTF-8?Q?a_b?= =?UTF-8?Q?c?=')).toBe('a bc');
    expect(decodeWords('texte simple')).toBe('texte simple');
  });
});
