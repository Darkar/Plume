import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMasterKey } from '@plume/crypto';
import { describe, expect, it } from 'vitest';
import {
  commitRotation,
  initSecretsDir,
  prepareRotation,
  rotationPaths,
} from '../src/secrets-dir.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'plume-secrets-'));
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const tamper = (dir: string, file: string, content: string) => {
  rmSync(join(dir, file));
  writeFileSync(join(dir, file), content, { mode: 0o600 });
};
const mode = (dir: string, file: string) => statSync(join(dir, file)).mode & 0o777;

describe('dossier de secrets de la pile Docker', () => {
  it('génère des secrets cohérents, avec des droits restreints', () => {
    const dir = fresh();
    const { created } = initSecretsDir(dir);
    expect(created).toEqual([
      'app/plume_master_key',
      'postgres/postgres_password',
      'redis/redis_password',
    ]);
    expect(parseMasterKey(read(dir, 'app/plume_master_key'))).toHaveLength(32);
    const pg = read(dir, 'postgres/postgres_password');
    const redis = read(dir, 'redis/redis_password');
    expect(pg).toMatch(/^[0-9a-f]{64}$/);
    expect(pg).not.toBe(redis);
    expect(read(dir, 'app/database_url')).toBe(`postgres://plume:${pg}@postgres:5432/plume`);
    expect(read(dir, 'app/redis_url')).toBe(`redis://plume:${redis}@redis:6379/0`);
    expect(read(dir, 'redis/redis_acl')).toContain(`user plume on >${redis} `);
    expect(read(dir, 'redis/redis_acl')).toContain('user default off');
    expect(mode(dir, 'app')).toBe(0o700);
    expect(mode(dir, 'app/plume_master_key')).toBe(0o400);
    expect(mode(dir, 'app/database_url')).toBe(0o400);
    expect(mode(dir, 'postgres/postgres_password')).toBe(0o444);
  });

  it('est idempotent et ne régénère jamais une valeur existante', () => {
    const dir = fresh();
    initSecretsDir(dir);
    const before = ['app/plume_master_key', 'postgres/postgres_password', 'app/redis_url'].map(
      (f) => read(dir, f),
    );
    expect(initSecretsDir(dir).created).toEqual([]);
    expect(
      ['app/plume_master_key', 'postgres/postgres_password', 'app/redis_url'].map((f) =>
        read(dir, f),
      ),
    ).toEqual(before);
  });

  it('répare les fichiers dérivés manquants à partir des valeurs de référence', () => {
    const dir = fresh();
    initSecretsDir(dir);
    const url = read(dir, 'app/database_url');
    // Fichiers en lecture seule : on les remplace (comme le ferait un tiers), sans les ouvrir.
    tamper(dir, 'app/database_url', 'altéré');
    initSecretsDir(dir);
    expect(read(dir, 'app/database_url')).toBe(url);
  });

  it('refuse une valeur de référence invalide', () => {
    const dir = fresh();
    initSecretsDir(dir);
    tamper(dir, 'redis/redis_password', 'court');
    expect(() => initSecretsDir(dir)).toThrow(/redis_password/);
  });

  it('rotation : nouvelle clé préparée, réutilisée après interruption, puis mise en place', () => {
    const dir = fresh();
    initSecretsDir(dir);
    const original = read(dir, 'app/plume_master_key');
    const first = prepareRotation(dir);
    expect(first.current).toBe(original);
    expect(first.next).not.toBe(original);
    // Reprise après interruption : la même nouvelle clé est réutilisée.
    expect(prepareRotation(dir)).toEqual(first);
    commitRotation(dir);
    const paths = rotationPaths(dir);
    expect(readFileSync(paths.current, 'utf8')).toBe(first.next);
    expect(readFileSync(paths.previous, 'utf8')).toBe(original);
    expect(existsSync(paths.next)).toBe(false);
  });
});
