import { EventEmitter } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { configSchema, type PlumeConfig, type SecretRef } from './schema.js';

/** Taille maximale acceptée pour le fichier de configuration (protection contre les abus). */
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  - ${i}`).join('\n')}` : message);
    this.name = 'ConfigError';
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(racine)';
    if (issue.code === 'unrecognized_keys') {
      return `${path} : champ(s) inconnu(s) ${issue.keys.map((k) => `« ${k} »`).join(', ')}`;
    }
    return `${path} : ${issue.message}`;
  });
}

/** Analyse et valide le contenu YAML. Lève une ConfigError explicite au moindre problème. */
export function parseConfig(source: string): PlumeConfig {
  if (source.trim() === '') {
    throw new ConfigError('Fichier de configuration vide', [
      'copiez config/plume.example.yaml en config/plume.yaml puis adaptez-le',
    ]);
  }
  const doc = parseDocument(source, {
    uniqueKeys: true,
    prettyErrors: true,
    strict: true,
    // Désactive les balises personnalisées et limite les alias (attaque « billion laughs »).
    customTags: [],
  });
  if (doc.errors.length > 0) {
    throw new ConfigError(
      'Configuration YAML illisible',
      doc.errors.map((e) => e.message),
    );
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new ConfigError('Configuration YAML illisible', [(error as Error).message]);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError('Configuration invalide', formatIssues(result.error));
  }
  return result.data;
}

/** Lit et valide le fichier de configuration. */
export function loadConfig(path: string): PlumeConfig {
  let source: string;
  try {
    // Chemin fourni par l'administrateur (variable PLUME_CONFIG), jamais par un utilisateur.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stats = statSync(path);
    if (!stats.isFile()) throw new ConfigError(`${path} n'est pas un fichier`);
    if (stats.size > MAX_CONFIG_BYTES) throw new ConfigError(`${path} est trop volumineux`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Impossible de lire la configuration ${path}`, [
      (error as NodeJS.ErrnoException).code ?? 'erreur inconnue',
    ]);
  }
  return parseConfig(source);
}

/**
 * Lit un secret référencé par la configuration. Le contenu n'est jamais inclus dans les erreurs.
 */
export function readSecret(ref: SecretRef, env: NodeJS.ProcessEnv = process.env): string {
  if (ref.kind === 'env') {
    const value = env[ref.name];
    if (value === undefined || value.trim() === '') {
      throw new ConfigError(`Secret manquant : variable d'environnement ${ref.name}`);
    }
    return value.trim();
  }
  return readSecretFile(ref.path);
}

export function readSecretFile(path: string): string {
  let value: string;
  try {
    // Chemin de secret issu de la configuration validée (administrateur), jamais d'un utilisateur.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stats = statSync(path);
    if (stats.size > MAX_SECRET_BYTES) throw new ConfigError(`Secret ${path} trop volumineux`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    value = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Secret illisible : ${path}`, [
      (error as NodeJS.ErrnoException).code ?? 'erreur inconnue',
    ]);
  }
  if (value === '') throw new ConfigError(`Secret vide : ${path}`);
  return value;
}

/** Sections pouvant être rechargées à chaud (SIGHUP). Tout le reste nécessite un redémarrage. */
export interface ReloadResult {
  removedDomains: string[];
  ignoredSections: string[];
}

export interface ConfigStoreEvents {
  reload: [config: PlumeConfig, result: ReloadResult];
}

/**
 * Conserve la configuration courante et gère le rechargement à chaud de la liste blanche
 * et des limites. Une configuration invalide au rechargement est ignorée (l'ancienne reste active).
 */
export class ConfigStore extends EventEmitter<ConfigStoreEvents> {
  #current: PlumeConfig;

  constructor(
    readonly path: string,
    initial?: PlumeConfig,
  ) {
    super();
    this.#current = initial ?? loadConfig(path);
  }

  get current(): PlumeConfig {
    return this.#current;
  }

  reload(): ReloadResult {
    const next = loadConfig(this.path);
    return this.apply(next);
  }

  apply(next: PlumeConfig): ReloadResult {
    const previous = this.#current;
    const ignoredSections: string[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    for (const key of ['server', 'database', 'redis', 'logging'] as const) {
      if (!same(previous[key], next[key])) ignoredSections.push(key);
    }
    const { rate_limit: nextRateLimit, ...nextAuthRest } = next.auth;
    const { rate_limit: _prevRateLimit, ...prevAuthRest } = previous.auth;
    if (!same(prevAuthRest, nextAuthRest)) ignoredSections.push('auth (hors rate_limit)');
    if (previous.security.master_key_file !== next.security.master_key_file) {
      ignoredSections.push('security.master_key_file');
    }

    const nextDomains = new Set(next.domains.map((d) => d.domain));
    const removedDomains = previous.domains
      .map((d) => d.domain)
      .filter((domain) => !nextDomains.has(domain));

    this.#current = Object.freeze({
      ...previous,
      domains: next.domains,
      auth: { ...previous.auth, rate_limit: nextRateLimit },
      security: {
        ...next.security,
        master_key_file: previous.security.master_key_file,
      },
      rules: next.rules,
    });

    const result = { removedDomains, ignoredSections };
    this.emit('reload', this.#current, result);
    return result;
  }
}
