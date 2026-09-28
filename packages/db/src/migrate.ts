import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATION_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Clé arbitraire du verrou consultatif : une seule instance applique les migrations à la fois.
const LOCK_KEY = 0x706c756d; // « plum »

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  // Dossier interne à l'application, jamais fourni par un utilisateur.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readdirSync(dir)
    .filter((file) => MIGRATION_RE.test(file))
    .sort()
    .map((file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: file.slice(0, 4),
        name: file,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/**
 * Applique les migrations manquantes, chacune dans sa transaction. Refuse de continuer si une
 * migration déjà appliquée a été modifiée (empreinte différente).
 */
export async function migrate(
  pool: pg.Pool,
  migrations: Migration[] = loadMigrations(),
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS plume_migrations (
        version     text PRIMARY KEY,
        name        text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM plume_migrations',
    );
    const done = new Map(rows.map((row) => [row.version, row.checksum]));
    for (const migration of migrations) {
      const checksum = done.get(migration.version);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error(`migration ${migration.name} modifiée après application`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO plume_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
