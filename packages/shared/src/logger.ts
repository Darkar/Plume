import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

/** Clés dont la valeur est toujours masquée, quelle que soit leur profondeur. */
const SENSITIVE_KEY_RE =
  /pass(word|wd)?|secret|token|cookie|authorization|api[-_]?key|session|sid|csrf|totp|otp|credential|master[-_]?key|private[-_]?key|body|html|text|content|attachment/i;

export const REDACTED = '[masqué]';

/** Chemins masqués par pino (en-têtes HTTP notamment). */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

const MAX_DEPTH = 6;

/**
 * Masque récursivement les champs sensibles d'un objet de journalisation.
 * Les journaux ne doivent jamais contenir de mot de passe, de jeton ni de contenu de mail.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[profondeur max]';
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (value instanceof Error) return value;
  // Seuls les objets simples sont parcourus : les instances (requête HTTP…) sont laissées aux
  // sérialiseurs de pino, qui n'en extraient que des champs sûrs.
  const proto =
    value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (
    value !== null &&
    typeof value === 'object' &&
    (proto === Object.prototype || proto === null)
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactSensitive(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerSettings {
  level: string;
  format: 'json' | 'pretty';
  name: string;
}

export function loggerOptions(settings: LoggerSettings): LoggerOptions {
  return {
    name: settings.name,
    level: settings.level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    formatters: {
      log: (object) => redactSensitive(object) as Record<string, unknown>,
    },
    serializers: {
      err: stdSerializers.err,
      error: stdSerializers.err,
    },
    ...(settings.format === 'pretty' ? { transport: { target: 'pino-pretty' } } : {}),
  };
}

export function createLogger(settings: LoggerSettings, destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(settings), destination) : pino(loggerOptions(settings));
}

export type { Logger };
