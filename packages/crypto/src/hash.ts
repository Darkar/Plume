import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

/** Paramètres Argon2id (OWASP : m ≥ 19 Mio, t ≥ 2). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, ARGON2_OPTIONS);
}

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

// Alphabet sans caractères ambigus (0/O, 1/l/I).
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Génère des codes de secours de la forme « xxxxx-xxxxx » (~49 bits d'entropie chacun). */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    let code = '';
    for (let i = 0; i < 10; i++) code += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Normalise un code de secours saisi (casse, espaces, tirets). */
export function normalizeBackupCode(input: string): string | null {
  const compact = input.toLowerCase().replace(/[\s-]/g, '');
  if (compact.length !== 10) return null;
  for (const char of compact) if (!BACKUP_ALPHABET.includes(char)) return null;
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}
