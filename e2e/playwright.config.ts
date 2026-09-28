import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Tests de bout en bout contre la pile Docker (compose.yaml + deploy/docker-compose.e2e.yml).
const baseURL = process.env.PLUME_E2E_URL ?? 'https://localhost';
const localChromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  // GreenMail (serveur de test) est lent sur les boîtes volumineuses.
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // Certificat émis par l'autorité locale de Caddy.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    locale: 'fr-FR',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLUME_E2E_CHROMIUM || existsSync(localChromium)
          ? { launchOptions: { executablePath: process.env.PLUME_E2E_CHROMIUM ?? localChromium } }
          : {}),
      },
    },
  ],
});
