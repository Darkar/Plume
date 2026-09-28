import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '@plume/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../src/client.js';
import { loadMigrations, migrate } from '../src/migrate.js';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  container = await startPostgres();
  handle = createDb(container.getConnectionUri());
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

describe('migrations', () => {
  it('applique toutes les migrations puis est idempotent', async () => {
    const first = await migrate(handle.pool);
    expect(first.length).toBe(loadMigrations().length);
    expect(await migrate(handle.pool)).toEqual([]);
    const { rows } = await handle.pool.query("SELECT to_regclass('users') AS t");
    expect(rows[0].t).toBe('users');
  });

  it('refuse une migration appliquée puis modifiée', async () => {
    const migrations = loadMigrations().map((m) => ({ ...m, checksum: 'modifiée' }));
    await expect(migrate(handle.pool, migrations)).rejects.toThrow(/modifiée après application/);
  });

  it('annule une migration en échec', async () => {
    const bad = {
      version: '9999',
      name: '9999_bad.sql',
      sql: 'CREATE TABLE tmp_ok (id int); SELECT * FROM table_inexistante;',
      checksum: 'x',
    };
    await expect(migrate(handle.pool, [...loadMigrations(), bad])).rejects.toThrow();
    const { rows } = await handle.pool.query("SELECT to_regclass('tmp_ok') AS t");
    expect(rows[0].t).toBeNull();
  });

  it('applique les contraintes (adresse en minuscules)', async () => {
    await expect(
      handle.pool.query("INSERT INTO users (email, domain) VALUES ('A@b.fr', 'b.fr')"),
    ).rejects.toThrow();
  });
});
