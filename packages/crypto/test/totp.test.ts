import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  timeStep,
  totpAt,
  totpUri,
  verifyTotp,
} from '../src/totp.js';

// Secret de la RFC 6238 (annexe B) pour SHA-1 : « 12345678901234567890 ».
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('vecteur de test T=%d → %s', (seconds, expected) => {
    expect(totpAt(RFC_SECRET, timeStep(seconds * 1000))).toBe(expected);
  });

  it('base32 aller-retour', () => {
    const data = Buffer.from('plume✓');
    expect(base32Decode(base32Encode(data))).toEqual(data);
    expect(() => base32Decode('abc1')).toThrow();
  });

  it('génère un secret de 160 bits', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('accepte le code courant et ±1 pas', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), { now }).step).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), { now }).step).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), { now }).step).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), { now }).step).toBeNull();
  });

  it('refuse un code rejoué', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, { now, lastUsedStep: step }).step).toBeNull();
    // Un code plus ancien que le dernier utilisé est aussi refusé.
    expect(
      verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), { now, lastUsedStep: step }).step,
    ).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { now, lastUsedStep: step - 1 }).step).toBe(step);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 456', '١٢٣٤٥٦'])('refuse le format %j', (code) => {
    expect(verifyTotp(RFC_SECRET, code).step).toBeNull();
  });

  it("construit l'URI otpauth", () => {
    const uri = totpUri('ABC', 'sacha@exemple.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Plume%3Asacha%40exemple\.com\?/);
    expect(uri).toContain('secret=ABC');
    expect(uri).toContain('issuer=Plume');
  });
});
