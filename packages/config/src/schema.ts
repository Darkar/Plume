import { isIP } from 'node:net';
import { z } from 'zod';
import { matchDomain, normalizeDomainPattern, normalizeEmail, normalizeHost } from './domains.js';
import { parseDuration, parseSize } from './units.js';

const duration = z.string().transform((value, ctx) => {
  const ms = parseDuration(value);
  if (ms === null) {
    ctx.addIssue({ code: 'custom', message: `durée invalide « ${value} » (ex. 15m, 12h, 30d)` });
    return z.NEVER;
  }
  return ms;
});

const size = z.string().transform((value, ctx) => {
  const bytes = parseSize(value);
  if (bytes === null) {
    ctx.addIssue({ code: 'custom', message: `taille invalide « ${value} » (ex. 512KB, 25MB)` });
    return z.NEVER;
  }
  return bytes;
});

const cidr = z.string().refine(
  (value) => {
    const [address, prefix, ...rest] = value.split('/');
    if (rest.length > 0 || !address) return false;
    const family = isIP(address);
    if (family === 0) return false;
    if (prefix === undefined) return true;
    if (!/^\d{1,3}$/.test(prefix)) return false;
    return Number(prefix) <= (family === 4 ? 32 : 128);
  },
  { message: 'adresse IP ou plage CIDR invalide' },
);

const hostname = z.string().transform((value, ctx) => {
  const normalized = normalizeHost(value);
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: `nom d'hôte invalide « ${value} »` });
    return z.NEVER;
  }
  return normalized;
});

const port = z.number().int().min(1).max(65535);

/** Référence vers un secret : un fichier (recommandé) ou une variable d'environnement. */
const secretRef = (name: string) =>
  z
    .strictObject({
      [`${name}_file`]: z.string().startsWith('/').optional(),
      [`${name}_env`]: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .optional(),
    })
    .refine((value) => Object.values(value).filter((v) => v !== undefined).length === 1, {
      message: `exactement un des champs « ${name}_file » ou « ${name}_env » est requis`,
    })
    .transform((value): SecretRef => {
      const file = value[`${name}_file`];
      return file !== undefined
        ? { kind: 'file', path: file }
        : { kind: 'env', name: value[`${name}_env`] as string };
    });

export type SecretRef = { kind: 'file'; path: string } | { kind: 'env'; name: string };

const mailServer = z.strictObject({
  host: hostname,
  port,
  security: z.enum(['tls', 'starttls']),
});

/**
 * Relais SMTP commun au domaine (prestataire d'envoi, relais du FAI…) : identifiant fixe et mot de
 * passe lu dans un secret. Sans ce bloc, l'envoi utilise les identifiants de la boîte.
 */
const smtpAuth = z
  .strictObject({
    username: z.string().trim().min(1).max(320),
    password_file: z.string().startsWith('/').optional(),
    password_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  })
  .refine((value) => (value.password_file === undefined) !== (value.password_env === undefined), {
    message: 'exactement un des champs « password_file » ou « password_env » est requis',
  })
  .transform((value): SmtpRelayAuth => ({
    username: value.username,
    password:
      value.password_file !== undefined
        ? { kind: 'file', path: value.password_file }
        : { kind: 'env', name: value.password_env as string },
  }));

export interface SmtpRelayAuth {
  username: string;
  password: SecretRef;
}

const smtpServer = mailServer.extend({ auth: smtpAuth.optional() });

const domainEntry = z.strictObject({
  domain: z.string().transform((value, ctx) => {
    const normalized = normalizeDomainPattern(value);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: `domaine invalide « ${value} » (domaine exact ou « *.domaine »)`,
      });
      return z.NEVER;
    }
    return normalized;
  }),
  imap: mailServer,
  smtp: smtpServer,
  /**
   * Comptes autorisés pour ce domaine (adresses complètes ou parties locales). Absent : tous les
   * comptes du domaine peuvent se connecter.
   */
  accounts: z
    .array(
      z.string().transform((value, ctx) => {
        const trimmed = value.trim();
        const email = normalizeEmail(
          trimmed.includes('@') ? trimmed : `${trimmed}@exemple.invalid`,
        );
        if (!email) {
          ctx.addIssue({ code: 'custom', message: `compte invalide « ${value} »` });
          return z.NEVER;
        }
        return trimmed.includes('@') ? email.address : email.local;
      }),
    )
    .min(1, 'liste de comptes vide : retirer « accounts » pour autoriser tout le domaine')
    .max(10_000)
    .optional(),
  /** Identifiant transmis au serveur : l'adresse complète (défaut) ou la seule partie locale. */
  login_format: z.enum(['email', 'local_part']).default('email'),
  tls: z
    .strictObject({
      reject_unauthorized: z.boolean().default(true),
      min_version: z.enum(['TLSv1.2', 'TLSv1.3']).default('TLSv1.2'),
    })
    .default({ reject_unauthorized: true, min_version: 'TLSv1.2' }),
});

/** Une adresse complète listée dans « accounts » doit appartenir au domaine de l'entrée. */
const domainEntryChecked = domainEntry.superRefine((entry, ctx) => {
  entry.accounts?.forEach((account, index) => {
    const at = account.lastIndexOf('@');
    if (at > 0 && !matchDomain([entry], account.slice(at + 1))) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', index],
        message: `« ${account} » n'appartient pas au domaine ${entry.domain}`,
      });
    }
  });
});

const rateLimit = z.strictObject({ max: z.number().int().min(1).max(10_000), window: duration });

export const configSchema = z
  .strictObject({
    server: z.strictObject({
      public_url: z
        .url({ protocol: /^https$/, message: 'public_url doit être une URL https://' })
        .transform((value) => new URL(value).origin),
      trusted_proxies: z.array(cidr).default([]),
      listen: z
        .strictObject({
          host: z.string().default('0.0.0.0'),
          port: port.default(3000),
        })
        .default({ host: '0.0.0.0', port: 3000 }),
    }),

    domains: z
      .array(domainEntryChecked)
      .min(1, 'la liste blanche doit contenir au moins un domaine')
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          if (seen.has(entry.domain)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'domain'],
              message: `domaine en double « ${entry.domain} »`,
            });
          }
          seen.add(entry.domain);
        });
      }),

    auth: z.strictObject({
      session_ttl: duration,
      idle_timeout: duration,
      remember_me_ttl: duration,
      totp: z.enum(['disabled', 'optional', 'required']).default('optional'),
      rate_limit: z.strictObject({
        per_ip: rateLimit,
        per_account: rateLimit.extend({ lockout: duration }),
      }),
    }),

    security: z.strictObject({
      master_key_file: z.string().startsWith('/'),
      remote_images: z.enum(['block_by_default', 'allow']).default('block_by_default'),
      max_attachment_size: size,
      max_upload_total: size,
    }),

    rules: z.strictObject({
      enabled: z.boolean().default(true),
      max_rules_per_user: z.number().int().min(0).max(1000).default(100),
      forward: z
        .strictObject({
          enabled: z.boolean().default(false),
          allowed_destination_domains: z
            .array(
              z.string().transform((value, ctx) => {
                const normalized = normalizeDomainPattern(value);
                if (!normalized) {
                  ctx.addIssue({ code: 'custom', message: `domaine invalide « ${value} »` });
                  return z.NEVER;
                }
                return normalized;
              }),
            )
            .default([]),
        })
        .default({ enabled: false, allowed_destination_domains: [] }),
    }),

    database: secretRef('url'),
    redis: secretRef('url'),

    logging: z
      .strictObject({
        level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
        format: z.enum(['json', 'pretty']).default('json'),
      })
      .default({ level: 'info', format: 'json' }),
  })
  .superRefine((config, ctx) => {
    if (config.auth.idle_timeout > config.auth.session_ttl) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'idle_timeout'],
        message: 'idle_timeout ne peut pas dépasser session_ttl',
      });
    }
    if (config.security.max_attachment_size > config.security.max_upload_total) {
      ctx.addIssue({
        code: 'custom',
        path: ['security', 'max_attachment_size'],
        message: 'max_attachment_size ne peut pas dépasser max_upload_total',
      });
    }
  });

export type PlumeConfig = z.output<typeof configSchema>;
export type DomainConfig = PlumeConfig['domains'][number];
export type MailServerConfig = DomainConfig['imap'];
