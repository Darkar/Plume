import { createHmac, randomBytes } from 'node:crypto';

/** TOTP (RFC 6238) : HMAC-SHA1, 6 chiffres, pas de 30 s — compatible avec toutes les applis. */
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('base32 invalide');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Génère un secret TOTP de 160 bits (recommandation RFC 4226), encodé en base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface TotpCheck {
  /** Pas de temps correspondant au code, ou null si le code est invalide. */
  step: number | null;
}

/**
 * Vérifie un code avec une tolérance de ±1 pas (dérive d'horloge). Un code dont le pas est
 * inférieur ou égal à `lastUsedStep` est refusé : un code déjà utilisé ne peut pas être rejoué.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: number; lastUsedStep?: number | null; window?: number } = {},
): TotpCheck {
  if (!/^\d{6}$/.test(code)) return { step: null };
  const current = timeStep(options.now);
  const window = options.window ?? 1;
  let matched: number | null = null;
  // On parcourt toute la fenêtre sans court-circuit pour limiter les écarts de temps.
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    const expected = totpAt(secret, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && matched === null) matched = step;
  }
  if (matched === null) return { step: null };
  if (options.lastUsedStep !== undefined && options.lastUsedStep !== null) {
    if (matched <= options.lastUsedStep) return { step: null };
  }
  return { step: matched };
}

/** URI « otpauth:// » à afficher sous forme de QR code dans l'application d'authentification. */
export function totpUri(secret: string, account: string, issuer = 'Plume'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
