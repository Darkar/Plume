/* eslint-disable security/detect-non-literal-fs-filename -- chemins construits à partir du
   dossier de secrets passé par l'administrateur (ligne de commande), jamais d'un utilisateur. */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secrets de la pile Docker, conservés dans un volume nommé et générés au premier démarrage par
 * le service « secrets » (voir deploy/docker-compose.yml et DECISIONS D-057).
 *
 * Organisation : un sous-dossier par consommateur, monté seul (sous-chemin de volume) dans le
 * conteneur concerné, sous /run/secrets :
 *
 * - app/       (api, worker ; 0700, UID 10001) : plume_master_key, database_url, redis_url ;
 * - postgres/  (postgres) : postgres_password ;
 * - redis/     (redis) : redis_acl, et redis_password (valeur de référence).
 *
 * Les valeurs de référence (clé maître, mots de passe) ne sont jamais régénérées ; les fichiers
 * qui en dérivent (URL, ACL) sont réécrits à chaque passage : l'opération est idempotente et
 * répare un dossier incomplet.
 */

export const MASTER_KEY_FILE = 'app/plume_master_key';

const DIRS = { app: 0o700, postgres: 0o755, redis: 0o755 } as const;

export interface InitResult {
  created: string[];
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function ensureValue(
  dir: string,
  file: string,
  generate: () => string,
  pattern: RegExp,
  mode: number,
  created: string[],
): string {
  const path = join(dir, file);
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (!pattern.test(value)) throw new Error(`secret invalide : ${file}`);
    return value;
  }
  const value = generate();
  writeAtomic(path, value, mode);
  created.push(file);
  return value;
}

function writeDerived(dir: string, file: string, content: string, mode: number): void {
  const path = join(dir, file);
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  writeAtomic(path, content, mode);
}

export function generateMasterKey(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('base64');
}

export function initSecretsDir(
  dir: string,
  random: (n: number) => Buffer = randomBytes,
): InitResult {
  const created: string[] = [];
  for (const [name, mode] of Object.entries(DIRS)) {
    mkdirSync(join(dir, name), { recursive: true, mode });
    chmodSync(join(dir, name), mode);
  }
  const hex = () => random(32).toString('hex');
  ensureValue(
    dir,
    MASTER_KEY_FILE,
    () => generateMasterKey(random),
    /^[A-Za-z0-9+/]{43}=$/,
    0o400,
    created,
  );
  const pg = ensureValue(dir, 'postgres/postgres_password', hex, /^[0-9a-f]{64}$/, 0o444, created);
  const redis = ensureValue(dir, 'redis/redis_password', hex, /^[0-9a-f]{64}$/, 0o400, created);

  writeDerived(dir, 'app/database_url', `postgres://plume:${pg}@postgres:5432/plume`, 0o400);
  writeDerived(dir, 'app/redis_url', `redis://plume:${redis}@redis:6379/0`, 0o400);
  writeDerived(
    dir,
    'redis/redis_acl',
    [
      'user default off',
      `user plume on >${redis} ~* &* +@all -@dangerous +info +client|setname +client|getname +client|id`,
      // L'utilisateur « health » n'a droit qu'à PING (sonde de santé sans mot de passe).
      'user health on nopass -@all +ping',
      '',
    ].join('\n'),
    0o444,
  );
  return { created };
}

/** Fichiers de la rotation de la clé maître dans le dossier de secrets. */
export function rotationPaths(dir: string) {
  const current = join(dir, MASTER_KEY_FILE);
  return { current, next: `${current}.next`, previous: `${current}.previous` };
}

/**
 * Prépare la rotation : la nouvelle clé est écrite à côté de l'actuelle (`.next`) avant tout
 * rechiffrement, pour qu'une reprise après interruption réutilise la même clé.
 */
export function prepareRotation(
  dir: string,
  random: (n: number) => Buffer = randomBytes,
): { current: string; next: string } {
  const paths = rotationPaths(dir);
  if (!existsSync(paths.next)) writeAtomic(paths.next, generateMasterKey(random), 0o400);
  return {
    current: readFileSync(paths.current, 'utf8').trim(),
    next: readFileSync(paths.next, 'utf8').trim(),
  };
}

/** Termine la rotation : l'ancienne clé devient `.previous`, la nouvelle devient la clé active. */
export function commitRotation(dir: string): void {
  const paths = rotationPaths(dir);
  renameSync(paths.current, paths.previous);
  renameSync(paths.next, paths.current);
}
