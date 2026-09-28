const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
};

const DURATION_RE = /^(\d{1,9})(ms|s|m|h|d)$/;
const SIZE_RE = /^(\d{1,9})(B|KB|MB|GB)$/;

/** Convertit « 15m », « 12h », « 30d »… en millisecondes. Renvoie null si le format est invalide. */
export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input.trim());
  if (!match) return null;
  const [, amount, unit] = match;
  const factor = DURATION_UNITS[unit as string];
  if (factor === undefined) return null;
  const value = Number(amount) * factor;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Convertit « 25MB », « 512KB »… en octets. Renvoie null si le format est invalide. */
export function parseSize(input: string): number | null {
  const match = SIZE_RE.exec(input.trim().toUpperCase());
  if (!match) return null;
  const [, amount, unit] = match;
  const factor = SIZE_UNITS[unit as string];
  if (factor === undefined) return null;
  const value = Number(amount) * factor;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
