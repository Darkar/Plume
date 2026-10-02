import { expect, login, test, USER } from './fixtures.js';

const ALICE = { email: 'alice@exemple.com', password: 'e2e-password-alice' };

test('signature, envoi, réception, archivage et annulation', async ({ browser }) => {
  test.setTimeout(120_000);
  const subject = `Point projet ${Date.now()}`;

  // Sacha enregistre une signature puis envoie un message à Alice.
  const sacha = await browser.newPage();
  await login(sacha, USER.email, USER.password);
  await sacha.getByRole('link', { name: 'Paramètres' }).click();
  const signature = sacha.getByRole('textbox', { name: 'Signature' });
  await signature.click();
  await sacha.keyboard.press('ControlOrMeta+a');
  await sacha.keyboard.type('Sacha — Plume');
  await sacha.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(sacha.getByText('Préférences enregistrées.')).toBeVisible();
  await sacha.getByRole('link', { name: /réception/i }).click();

  await sacha.getByRole('button', { name: 'Nouveau message' }).click();
  const dialog = sacha.getByRole('dialog');
  await dialog.getByLabel('À', { exact: true }).fill('Alice <alice@exemple.com>');
  await dialog.getByLabel('Objet').fill(subject);
  const body = dialog.getByRole('textbox', { name: 'Corps du message' });
  await expect(body).toContainText('Sacha — Plume');
  await body.click();
  await sacha.keyboard.press('ControlOrMeta+Home');
  await sacha.keyboard.type('Bonjour Alice,');
  await dialog.getByRole('button', { name: 'Envoyer' }).click();
  await expect(sacha.getByText('Message envoyé.')).toBeVisible();
  await sacha.close();

  // Alice reçoit, ouvre, puis archive et annule.
  const alice = await browser.newPage();
  await login(alice, ALICE.email, ALICE.password);
  const row = alice.getByRole('button').filter({ hasText: subject });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const frame = alice.frameLocator('iframe[title="Contenu du message"]');
  await expect(frame.getByText('Bonjour Alice,')).toBeVisible();
  await expect(frame.getByText('Sacha — Plume')).toBeVisible();

  await alice.getByRole('button', { name: 'Archiver' }).click();
  await expect(alice.getByText('Message archivé.')).toBeVisible();
  await expect(alice.getByRole('button').filter({ hasText: subject })).toHaveCount(0);
  await alice.getByRole('button', { name: 'Annuler' }).click();
  await expect(alice.getByText('Action annulée.')).toBeVisible();
  await expect(alice.getByRole('button').filter({ hasText: subject })).toBeVisible();

  // Réponse depuis la barre d'outils (plus de barre de réponse rapide en bas du message).
  await alice.getByRole('button').filter({ hasText: subject }).click();
  await expect(alice.getByLabel('Réponse rapide')).toHaveCount(0);
  await alice.getByRole('button', { name: 'Répondre', exact: true }).click();
  const reply = alice.getByRole('dialog');
  const replyBody = reply.getByRole('textbox', { name: 'Corps du message' });
  // La citation reprend le texte du message, jamais le script du document isolé.
  await expect(replyBody).toContainText('Bonjour Alice,');
  await expect(replyBody).not.toContainText('plume:body-height');
  await replyBody.click();
  await alice.keyboard.press('ControlOrMeta+Home');
  await alice.keyboard.type('Merci, bien reçu.');
  await reply.getByRole('button', { name: 'Envoyer' }).click();
  await expect(alice.getByText('Message envoyé.')).toBeVisible();
  await alice.close();
});

test('fermeture sans envoi : brouillon enregistré, repris puis envoyé', async ({ page }) => {
  test.setTimeout(120_000);
  const subject = `Brouillon ${Date.now()}`;
  await login(page, USER.email, USER.password);

  await page.getByRole('button', { name: 'Nouveau message' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('À', { exact: true }).fill('Alice <alice@exemple.com>');
  await dialog.getByLabel('Objet').fill(subject);
  const body = dialog.getByRole('textbox', { name: 'Corps du message' });
  await body.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('Texte à finir plus tard.');

  // La fermeture d'un message modifié propose de l'enregistrer.
  await dialog.getByRole('button', { name: 'Fermer la fenêtre de rédaction' }).click();
  await expect(page.getByText('Enregistrer ce message dans les brouillons ?')).toBeVisible();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Enregistrer le brouillon' })
    .click();
  await expect(page.getByText('Brouillon enregistré.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Le brouillon figure dans le dossier Brouillons et se reprend tel quel.
  await page.getByRole('link', { name: /Brouillons|Drafts/ }).click();
  const row = page.getByRole('button').filter({ hasText: subject });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await page.getByRole('button', { name: 'Reprendre le brouillon' }).click();
  const resumed = page.getByRole('dialog');
  await expect(resumed.getByLabel('Objet')).toHaveValue(subject);
  await expect(resumed.getByRole('textbox', { name: 'Corps du message' })).toContainText(
    'Texte à finir plus tard.',
  );
  await resumed.getByRole('button', { name: 'Envoyer' }).click();
  await expect(page.getByText('Message envoyé.')).toBeVisible();

  // Envoyé : le brouillon a disparu.
  await expect(page.getByRole('button').filter({ hasText: subject })).toHaveCount(0, {
    timeout: 20_000,
  });
});
