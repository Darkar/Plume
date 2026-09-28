import { describe, expect, it } from 'vitest';
import { generateBackupCodes, hashSecret, normalizeBackupCode, verifySecret } from '../src/hash.js';

describe('Argon2id', () => {
  it('hache et vérifie', async () => {
    const hash = await hashSecret('abcde-fghjk');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('abcde');
    expect(await verifySecret(hash, 'abcde-fghjk')).toBe(true);
    expect(await verifySecret(hash, 'abcde-fghjm')).toBe(false);
  });

  it('renvoie false sur un hash invalide', async () => {
    expect(await verifySecret('pas-un-hash', 'x')).toBe(false);
  });
});

describe('codes de secours', () => {
  it('génère des codes uniques bien formés', () => {
    const codes = generateBackupCodes(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });

  it('normalise la saisie', () => {
    expect(normalizeBackupCode(' ABCDE FGHJK ')).toBe('abcde-fghjk');
    expect(normalizeBackupCode('abcdefghjk')).toBe('abcde-fghjk');
    expect(normalizeBackupCode('abcde-fghj')).toBeNull();
    expect(normalizeBackupCode('abcde-fgh1k')).toBeNull();
  });
});
