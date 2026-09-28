import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  hmac,
  keyId,
  parseMasterKey,
  randomToken,
  safeEqual,
  SecretBox,
} from '../src/cipher.js';

const master = randomBytes(32);
const box = new SecretBox(master);
const USER = '3f1c0a52-8a9e-4d7e-9f00-0a1b2c3d4e5f';

function tamper(payload: string, index: number): string {
  const parts = payload.split('.');
  const bytes = Buffer.from(parts[index] as string, 'base64url');
  bytes[0] = (bytes[0] as number) ^ 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

describe('SecretBox', () => {
  it('chiffre puis déchiffre', () => {
    const payload = box.encrypt(USER, 'imap', 'mot de passe ✓');
    expect(box.decrypt(USER, 'imap', payload)).toBe('mot de passe ✓');
  });

  it('ne laisse pas apparaître le clair et utilise un IV aléatoire', () => {
    const a = box.encrypt(USER, 'imap', 'hunter2');
    const b = box.encrypt(USER, 'imap', 'hunter2');
    expect(a).not.toBe(b);
    expect(a).not.toContain('hunter2');
    expect(Buffer.from(a.split('.')[3] as string, 'base64url').toString()).not.toContain('hunter2');
  });

  it('est illisible sans la clé maître', () => {
    const payload = box.encrypt(USER, 'imap', 'hunter2');
    const other = new SecretBox(randomBytes(32));
    expect(() => other.decrypt(USER, 'imap', payload)).toThrow(CryptoError);
  });

  it.each([
    ['IV', 2],
    ['chiffré', 3],
    ['tag', 4],
  ])('détecte une altération du %s', (_name, index) => {
    const payload = box.encrypt(USER, 'imap', 'hunter2');
    expect(() => box.decrypt(USER, 'imap', tamper(payload, index))).toThrow(
      /échec de l’authentification/,
    );
  });

  it('refuse une valeur copiée vers un autre utilisateur', () => {
    const payload = box.encrypt(USER, 'imap', 'hunter2');
    expect(() => box.decrypt('autre-utilisateur', 'imap', payload)).toThrow(CryptoError);
  });

  it('refuse une valeur utilisée dans un autre contexte', () => {
    const payload = box.encrypt(USER, 'imap', 'hunter2');
    expect(() => box.decrypt(USER, 'totp', payload)).toThrow(CryptoError);
  });

  it.each(['', 'v2.a.b.c.d', 'v1.x', 'v1.a.b.c', 'pas-du-tout'])('refuse le format %j', (value) => {
    expect(() => box.decrypt(USER, 'imap', value)).toThrow(CryptoError);
  });

  it('refuse un tag tronqué', () => {
    const parts = box.encrypt(USER, 'imap', 'x').split('.');
    parts[4] = (parts[4] as string).slice(0, 8);
    expect(() => box.decrypt(USER, 'imap', parts.join('.'))).toThrow(/corrompues/);
  });

  it('signale une clé maître différente via keyId', () => {
    const payload = box.encrypt(USER, 'imap', 'x');
    expect(box.isCurrent(payload)).toBe(true);
    expect(new SecretBox(randomBytes(32)).isCurrent(payload)).toBe(false);
    expect(keyId(master)).toBe(box.keyId);
  });

  it('exige utilisateur et contexte', () => {
    expect(() => box.encrypt('', 'imap', 'x')).toThrow(CryptoError);
    expect(() => new SecretBox(randomBytes(16))).toThrow(CryptoError);
  });
});

describe('parseMasterKey', () => {
  it('accepte base64 et hexadécimal', () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString('base64'))).toEqual(key);
    expect(parseMasterKey(`${key.toString('hex')}\n`)).toEqual(key);
  });

  it.each([
    ['trop courte', randomBytes(16).toString('base64')],
    ['texte', 'correct horse battery staple'],
    ['vide', ''],
    ['constante', Buffer.alloc(32).toString('base64')],
  ])('refuse une clé %s', (_name, value) => {
    expect(() => parseMasterKey(value)).toThrow(CryptoError);
  });
});

describe('utilitaires', () => {
  it('randomToken produit 256 bits par défaut', () => {
    expect(Buffer.from(randomToken(), 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('safeEqual compare correctement', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('hmac est déterministe', () => {
    expect(hmac('k', 'data')).toBe(hmac('k', 'data'));
    expect(hmac('k', 'data')).not.toBe(hmac('k2', 'data'));
  });
});
