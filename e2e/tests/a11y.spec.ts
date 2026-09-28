import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { seedMailbox, type StartedGreenMail } from '@plume/testing';
import { expect, login, resetPreferences, test } from './fixtures.js';

/**
 * Accessibilité WCAG 2.2 niveau AA (axe-core) des pages principales, en thème clair et sombre.
 * Le contenu des mails (HTML de l'expéditeur, dans l'iframe isolée) est exclu : il ne dépend pas
 * de Plume.
 */
const DAVE = { email: 'dave@exemple.com', password: 'e2e-password-dave' };
const greenmail = {
  host: process.env.PLUME_E2E_IMAP_HOST ?? '127.0.0.1',
  imapsPort: Number(process.env.PLUME_E2E_IMAP_PORT ?? 3993),
} as StartedGreenMail;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude('iframe[title="Contenu du message"]')
    .analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
  }));
  expect(summary, `violations WCAG sur ${name}`).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedMailbox(greenmail, DAVE, [
    {
      subject: 'Accessibilité',
      from: 'Nimbus <factures@nimbus.example>',
      text: 'Bonjour',
      attachments: [{ filename: 'notes.txt', content: 'x', contentType: 'text/plain' }],
    },
  ]);
});

test('page de connexion (clair et sombre)', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/connexion');
    await expect(page.getByRole('heading', { name: 'Bon retour.' })).toBeVisible();
    await audit(page, `connexion (${scheme})`);
  }
});

for (const theme of ['Clair', 'Sombre'] as const) {
  test(`pages de l’application — thème ${theme}`, async ({ page, cspViolations }) => {
    test.setTimeout(90_000);
    void cspViolations;
    await login(page, DAVE.email, DAVE.password);
    await resetPreferences(page);
    await page.getByRole('link', { name: 'Paramètres' }).click();
    await page.getByRole('radio', { name: theme }).check();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme === 'Clair' ? 'light' : 'dark',
    );
    await audit(page, `paramètres généraux (${theme})`);

    await page.getByRole('link', { name: 'Sécurité' }).click();
    await expect(page.getByRole('heading', { name: 'Sécurité', level: 1 })).toBeVisible();
    await audit(page, `sécurité (${theme})`);

    await page.getByRole('link', { name: 'Règles' }).click();
    await page.getByRole('button', { name: 'Nouvelle règle' }).click();
    await expect(page.getByLabel('Nom de la règle')).toBeVisible();
    await audit(page, `éditeur de règle (${theme})`);

    await page.getByRole('link', { name: /réception/i }).click();
    await page.getByRole('button').filter({ hasText: 'Accessibilité' }).first().click();
    await expect(page.locator('#preview-subject')).toBeVisible();
    await audit(page, `boîte de réception et aperçu (${theme})`);

    await page.getByRole('button', { name: 'Plus d’actions' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await audit(page, `menu d’actions (${theme})`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByRole('button', { name: 'Libellés' }).click();
    await audit(page, `panneau des libellés (${theme})`);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Nouveau message' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, `rédaction (${theme})`);
  });
}

test.afterAll(async ({ browser }) => {
  // Remise des préférences par défaut pour les autres tests.
  const page = await browser.newPage();
  await login(page, DAVE.email, DAVE.password);
  await resetPreferences(page);
  await page.close();
});
