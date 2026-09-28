import { expect, login, test } from './fixtures.js';

const BOB = { email: 'bob@exemple.com', password: 'e2e-password-bob' };
const ALICE = { email: 'alice@exemple.com', password: 'e2e-password-alice' };

test('ajouter un compte, basculer de l’un à l’autre, puis le fermer', async ({
  page,
  cspViolations,
}) => {
  void cspViolations;
  await login(page, BOB.email, BOB.password);
  // Nom accessible de la carte de compte (correspondance partielle).
  const card = (email: string) => page.getByRole('button', { name: `Compte : ${email}` });

  await card(BOB.email).click();
  await page.getByRole('menuitem', { name: 'Ajouter un compte' }).click();
  await page.getByLabel('Adresse e-mail').fill(ALICE.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(ALICE.password);
  await page.getByRole('button', { name: 'Ajouter le compte' }).click();

  // Le compte ajouté devient actif.
  await expect(card(ALICE.email)).toBeVisible();
  const me = async () => (await (await page.request.get('/api/v1/me')).json()).email as string;
  expect(await me()).toBe(ALICE.email);

  await card(ALICE.email).click();
  await page.getByRole('menuitem', { name: `Passer à ${BOB.email}` }).click();
  await expect(card(BOB.email)).toBeVisible();
  expect(await me()).toBe(BOB.email);

  await card(BOB.email).click();
  await page.getByRole('menuitem', { name: `Fermer ${BOB.email}` }).click();
  await expect(card(ALICE.email)).toBeVisible();
  await card(ALICE.email).click();
  await expect(page.getByRole('menuitem', { name: /Passer à/ })).toHaveCount(0);
});
