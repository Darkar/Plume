import { timeStep, totpAt } from '../../packages/crypto/src/totp.js';
import { expect, login, logout, test } from './fixtures.js';

const ALICE = { email: 'alice@exemple.com', password: 'e2e-password-alice' };

/** Code du pas de temps suivant : évite de réutiliser un code déjà consommé (anti-rejeu). */
async function freshCode(secret: string, lastStep: { value: number }) {
  let step = timeStep();
  while (step <= lastStep.value) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    step = timeStep();
  }
  lastStep.value = step;
  return totpAt(secret, step);
}

test('activation du TOTP puis connexion en deux étapes', async ({ page, cspViolations }) => {
  test.setTimeout(150_000);
  void cspViolations;
  const lastStep = { value: 0 };

  await login(page, ALICE.email, ALICE.password);
  await expect(page.getByRole('searchbox', { name: 'Rechercher' })).toBeVisible();
  // La session survit au rechargement de la page.
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Rechercher' })).toBeVisible();

  await page.getByRole('link', { name: 'Paramètres' }).click();
  await page.getByRole('link', { name: 'Sécurité' }).click();
  await page.getByRole('button', { name: 'Activer' }).click();
  await page.getByRole('button', { name: 'Commencer' }).click();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  const secret = (await page.locator('code').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);

  await page.getByLabel('Code de vérification').fill(await freshCode(secret, lastStep));
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByRole('heading', { name: 'Codes de secours' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="backup-title"] li')).toHaveCount(10);
  await page.getByRole('button', { name: 'J’ai conservé mes codes' }).click();

  await logout(page);
  await login(page, ALICE.email, ALICE.password);
  await expect(page.getByRole('heading', { name: 'Vérification en deux étapes' })).toBeVisible();
  await page.getByLabel('Code de vérification').fill('000000');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert')).toHaveText('Code incorrect.');
  await page.getByLabel('Code de vérification').fill(await freshCode(secret, lastStep));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('searchbox', { name: 'Rechercher' })).toBeVisible();

  // Remise à l'état initial pour les exécutions suivantes.
  await page.getByRole('link', { name: 'Paramètres' }).click();
  await page.getByRole('link', { name: 'Sécurité' }).click();
  await page.getByLabel('Code actuel de votre application').fill(await freshCode(secret, lastStep));
  await page.getByRole('button', { name: 'Désactiver' }).click();
  await expect(page.getByText('Désactivée.')).toBeVisible();
});
