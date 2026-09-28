import { AxeBuilder } from '@axe-core/playwright';
import { seedMailbox, type StartedGreenMail } from '@plume/testing';
import { expect, login, test } from './fixtures.js';

const DAVE = { email: 'dave@exemple.com', password: 'e2e-password-dave' };
const greenmail = {
  host: process.env.PLUME_E2E_IMAP_HOST ?? '127.0.0.1',
  imapsPort: Number(process.env.PLUME_E2E_IMAP_PORT ?? 3993),
} as StartedGreenMail;
const subject = `Mobile ${Date.now()}`;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeAll(async () => {
  await seedMailbox(greenmail, DAVE, [{ subject, from: 'X <x@exemple.fr>', text: 'Bonjour' }]);
});

test('téléphone : tiroir de navigation, lecture et rédaction', async ({ page, cspViolations }) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  const menu = page.getByRole('button', { name: /^Menu/ });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  // Tiroir fermé : sa navigation est hors d'atteinte.
  await expect(page.getByRole('link', { name: 'Favoris' })).toHaveCount(0);

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await page.getByRole('link', { name: 'Favoris' }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/');

  await page.getByRole('button').filter({ hasText: subject }).click();
  await expect(page.locator('#preview-subject')).toHaveText(subject);
  await expect(page.getByRole('button', { name: 'Archiver' })).toBeVisible();
  await page.getByRole('button', { name: 'Fermer' }).click();
  await expect(page.getByRole('button').filter({ hasText: subject })).toBeVisible();

  await page.getByRole('button', { name: 'Nouveau message' }).first().click();
  const dialog = page.getByRole('dialog');
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('aucune page ne défile au-delà de l’écran (pas de zone vide)', async ({
  page,
  cspViolations,
}) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(await overflow()).toBe(0);
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('link', { name: 'Paramètres' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Les champs masqués (couleur d'accent, densité…) restent dans le panneau défilant.
  expect(await overflow()).toBe(0);
});
