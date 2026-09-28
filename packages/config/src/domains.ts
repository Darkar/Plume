import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const LABEL_CHARS_RE = /^[a-z0-9-]+$/;
// Caractères autorisés dans un atome de partie locale « dot-atom » (RFC 5322), ASCII uniquement.
const ATOM_CHARS_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
// Lettres, marques et chiffres (IDN), tirets et points : pas de « / », « : », « [ »…
const DOMAIN_INPUT_RE = /^[\p{L}\p{M}\p{N}.-]+$/u;

/** Plages de points de code interdits : contrôles C0/C1, espaces et séparateurs invisibles. */
const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0020],
  [0x007f, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

export function hasForbiddenChars(input: string): boolean {
  for (const char of input) {
    const code = char.codePointAt(0) as number;
    if (FORBIDDEN_RANGES.some(([min, max]) => code >= min && code <= max)) return true;
  }
  return false;
}

function isValidLabel(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    LABEL_CHARS_RE.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

function isValidLocalPart(local: string): boolean {
  return local.split('.').every((atom) => atom.length > 0 && ATOM_CHARS_RE.test(atom));
}

export const MAX_EMAIL_LENGTH = 254;

/**
 * Convertit un nom de domaine (éventuellement IDN) en forme ASCII (punycode) en minuscules.
 * Renvoie null si le nom n'est pas un nom d'hôte DNS valide d'au moins deux labels.
 */
export function normalizeDomain(input: string): string | null {
  if (input.length === 0 || input.length > 253) return null;
  if (hasForbiddenChars(input) || !DOMAIN_INPUT_RE.test(input)) return null;
  const ascii = domainToASCII(input.toLowerCase());
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every(isValidLabel)) return null;
  // Le TLD ne peut pas être entièrement numérique (évite les adresses IP déguisées).
  if (/^\d+$/.test(labels[labels.length - 1] as string)) return null;
  return ascii;
}

/**
 * Normalise un nom d'hôte de serveur fourni par l'administrateur : nom DNS (y compris à un seul
 * label, ex. « dovecot » sur un réseau Docker) ou adresse IP littérale.
 */
export function normalizeHost(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (isIP(value) !== 0) return value;
  if (value.length === 0 || value.length > 253) return null;
  if (hasForbiddenChars(value) || !DOMAIN_INPUT_RE.test(value)) return null;
  const ascii = domainToASCII(value);
  if (!ascii || !ascii.split('.').every(isValidLabel)) return null;
  return ascii;
}

export interface NormalizedEmail {
  address: string;
  local: string;
  domain: string;
}

/**
 * Normalise une adresse saisie par l'utilisateur : trim, minuscules, domaine en punycode.
 * Toute adresse ambiguë (plusieurs « @ », caractères de contrôle, espaces internes…) est rejetée.
 */
export function normalizeEmail(input: unknown): NormalizedEmail | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (hasForbiddenChars(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0 || at !== lower.lastIndexOf('@')) return null;
  const local = lower.slice(0, at);
  const rawDomain = lower.slice(at + 1);
  if (local.length > 64 || !isValidLocalPart(local)) return null;
  const domain = normalizeDomain(rawDomain);
  if (!domain) return null;
  const address = `${local}@${domain}`;
  if (address.length > MAX_EMAIL_LENGTH) return null;
  return { address, local, domain };
}

/**
 * Valide et normalise un motif de la liste blanche : domaine exact ou « *.domaine » (sous-domaines).
 */
export function normalizeDomainPattern(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.startsWith('*.')) {
    const base = normalizeDomain(trimmed.slice(2));
    return base ? `*.${base}` : null;
  }
  return normalizeDomain(trimmed);
}

/**
 * Cherche l'entrée de la liste blanche correspondant à un domaine déjà normalisé.
 * Priorité : correspondance exacte, puis le joker le plus spécifique.
 * Un joker « *.exemple.fr » n'autorise PAS « exemple.fr » lui-même.
 */
export function matchDomain<T extends { domain: string }>(
  entries: readonly T[],
  domain: string,
): T | null {
  let best: T | null = null;
  let bestLength = -1;
  for (const entry of entries) {
    if (entry.domain === domain) return entry;
    if (entry.domain.startsWith('*.')) {
      const suffix = entry.domain.slice(1); // « .exemple.fr »
      if (domain.length > suffix.length && domain.endsWith(suffix) && suffix.length > bestLength) {
        best = entry;
        bestLength = suffix.length;
      }
    }
  }
  return best;
}

/**
 * Comptes autorisés d'une entrée : adresses complètes ou parties locales (« sacha »), déjà
 * normalisées. Absent : tout le domaine est autorisé.
 */
export interface AccountRestricted {
  domain: string;
  accounts?: readonly string[];
}

/**
 * Cherche l'entrée de la liste blanche autorisant une adresse déjà normalisée : son domaine doit
 * correspondre et, si l'entrée restreint les comptes, l'adresse (ou sa partie locale) y figurer.
 */
export function matchAccount<T extends AccountRestricted>(
  entries: readonly T[],
  email: string,
): T | null {
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const entry = matchDomain(entries, email.slice(at + 1));
  if (!entry) return null;
  if (!entry.accounts) return entry;
  return entry.accounts.includes(email) || entry.accounts.includes(email.slice(0, at))
    ? entry
    : null;
}
