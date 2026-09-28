import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/{api,worker}/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/{api,worker}/test/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      './apps/web/vite.config.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      // Points d'entrée (composition, signaux, écoute) et visionneuse PDF (exécutée dans une
      // iframe à origine opaque) : couverts par les tests de bout en bout (DECISIONS D-055).
      exclude: [
        '**/*.d.ts',
        'apps/web/src/main.tsx',
        'apps/*/src/cli.ts',
        'apps/api/src/main.ts',
        'apps/worker/src/main.ts',
        'apps/web/src/viewer/pdf-viewer.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: {
        lines: 80,
        statements: 80,
        'packages/rules/src/**': { lines: 90, statements: 90 },
        'packages/config/src/**': { lines: 90, statements: 90 },
        'packages/crypto/src/**': { lines: 90, statements: 90 },
      },
    },
  },
});
