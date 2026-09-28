import { seedMailbox, type StartedGreenMail } from '@plume/testing';
import { expect, login, test } from './fixtures.js';

const CAROL = { email: 'carol@exemple.com', password: 'e2e-password-carol' };
const greenmail = {
  host: process.env.PLUME_E2E_IMAP_HOST ?? '127.0.0.1',
  imapsPort: Number(process.env.PLUME_E2E_IMAP_PORT ?? 3993),
} as StartedGreenMail;

test('une règle créée dans l’interface est appliquée par le worker aux nouveaux messages', async ({
  page,
  cspViolations,
}) => {
  test.setTimeout(120_000);
  void cspViolations;
  const tag = `tri${Date.now()}`;

  await login(page, CAROL.email, CAROL.password);
  await page.getByRole('link', { name: 'Paramètres' }).click();
  await page.getByRole('link', { name: 'Règles' }).click();
  await page.getByRole('button', { name: 'Nouvelle règle' }).click();
  await page.getByLabel('Nom de la règle').fill(`Tri automatique ${tag}`);
  await page.getByLabel('Champ').selectOption('subject');
  await page.getByLabel('Valeur').fill(tag);
  await page.getByLabel('Action', { exact: true }).selectOption('add_label');
  await page.getByLabel('Libellé', { exact: true }).fill('Tri');
  await page.getByRole('button', { name: 'Ajouter une action' }).click();
  await page.getByLabel('Action', { exact: true }).nth(1).selectOption('star');

  // Test à blanc (aucun message ne correspond encore), puis enregistrement.
  await page.getByRole('button', { name: /Tester/ }).click();
  await expect(page.getByText(/0 message\(s\) correspondant\(s\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Enregistrer la règle' }).click();
  await expect(page.getByRole('heading', { name: `Tri automatique ${tag}` })).toBeVisible();

  // Laisse le worker prendre en compte la règle (positionnement du curseur, connexion IDLE).
  await page.waitForTimeout(6_000);
  await seedMailbox(greenmail, CAROL, [{ subject: `Commande ${tag}`, text: 'x' }]);

  await page.getByRole('link', { name: /réception/i }).click();
  const row = page.getByRole('button').filter({ hasText: `Commande ${tag}` });
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText('Tri', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(row.getByText('Favori')).toBeAttached();
});

test('créer une règle depuis un message, la dupliquer et réordonner par glisser-déposer', async ({
  page,
  cspViolations,
}) => {
  test.setTimeout(90_000);
  void cspViolations;
  const tag = `depuis${Date.now()}`;
  await seedMailbox(greenmail, CAROL, [
    { subject: `Lettre ${tag}`, from: 'Gazette <gazette@exemple.fr>', text: 'x' },
  ]);
  await login(page, CAROL.email, CAROL.password);
  await page
    .getByRole('button')
    .filter({ hasText: `Lettre ${tag}` })
    .click();
  await page.getByRole('button', { name: 'Plus d’actions' }).click();
  await page.getByRole('menuitem', { name: 'Créer une règle à partir de ce message' }).click();

  await expect(page.getByLabel('Nom de la règle')).toHaveValue('Messages de Gazette');
  await page.getByLabel('Nom de la règle').fill(`Gazette ${tag}`);
  await expect(page.getByLabel('Valeur').first()).toHaveValue('gazette@exemple.fr');
  await page.getByRole('button', { name: 'Enregistrer la règle' }).click();
  await expect(page.getByRole('heading', { name: `Gazette ${tag}` })).toBeVisible();

  await page
    .getByRole('listitem')
    .filter({ hasText: `Gazette ${tag}` })
    .getByRole('button', { name: 'Dupliquer' })
    .click();
  await expect(page.getByRole('heading', { name: `Gazette ${tag} (copie)` })).toBeVisible();

  // Glisser la copie (dernière règle) sur l'originale, juste au-dessus : elle passe devant.
  const cards = page.getByRole('main').getByRole('listitem');
  const original = cards.filter({ hasText: `Gazette ${tag}` }).filter({ hasNotText: '(copie)' });
  const copy = cards.filter({ hasText: `Gazette ${tag} (copie)` });
  await copy.getByText('⠿').dragTo(original.getByText('⠿'));
  const order = async () => {
    const names = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents();
    return names.indexOf(`Gazette ${tag} (copie)`) < names.indexOf(`Gazette ${tag}`);
  };
  await expect.poll(order).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: `Gazette ${tag} (copie)` })).toBeVisible();
  await expect.poll(order).toBe(true);
});
