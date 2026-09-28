import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts', 'src/healthcheck.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Les paquets du monorepo sont intégrés au bundle ; toutes les dépendances npm restent externes
  // (installées dans l'image par « pnpm deploy »).
  noExternal: [/^@plume\//],
  external: [/^(?!@plume\/)[^./]/],
});
