import type { Page } from '@playwright/test';
import { XSS_PAYLOADS } from '../../packages/mail/test/fixtures/xss-corpus.js';
import { expect, login, test } from './fixtures.js';

/**
 * Charges XSS dans la signature : enregistrée par l'API (et donc nettoyée côté serveur), puis
 * affichée dans les paramètres, insérée dans le composeur, envoyée et relue par le
 * destinataire. Aucune ne doit s'exécuter (window.__xss, boîtes de dialogue, CSP).
 */
const CAROL = { email: 'carol@exemple.com', password: 'e2e-password-carol' };

async function patchPreferences(page: Page, data: Record<string, unknown>) {
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
  const session = await page.request.get('/api/v1/auth/session');
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const res = await page.request.patch('/api/v1/me/preferences', {
    headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin },
    data,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { signatureHtml: string };
}

async function expectNoExecution(page: Page, dialogs: string[]) {
  expect(dialogs).toEqual([]);
  for (const frame of page.frames()) {
    expect(
      await frame.evaluate(() => (window as unknown as { __xss?: unknown }).__xss),
    ).toBeUndefined();
  }
}

test('aucune charge XSS de la signature ne s’exécute (paramètres, rédaction, réception)', async ({
  page,
  cspViolations,
}) => {
  test.setTimeout(120_000);
  void cspViolations;
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const subject = `Signature piégée ${Date.now()}`;

  await login(page, CAROL.email, CAROL.password);
  const saved = await patchPreferences(page, {
    signatureHtml: `<p>Carol-signature</p>${XSS_PAYLOADS.join('\n')}`,
  });
  // Nettoyage côté serveur : ni script, ni gestionnaire d'événement, ni URL javascript:.
  expect(saved.signatureHtml).toContain('Carol-signature');
  expect(saved.signatureHtml).not.toMatch(/<script|\son\w+\s*=|javascript:/i);

  // Paramètres : la signature est chargée dans l'éditeur.
  await page.goto('/parametres');
  await expect(page.getByRole('textbox', { name: 'Signature' })).toContainText('Carol-signature');
  await expectNoExecution(page, dialogs);

  // Rédaction : la signature est insérée dans le corps, puis le message est envoyé à soi-même.
  await page.getByRole('link', { name: /réception/i }).click();
  await page.getByRole('button', { name: 'Nouveau message' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('À', { exact: true }).fill(CAROL.email);
  await dialog.getByLabel('Objet').fill(subject);
  await expect(dialog.getByRole('textbox', { name: 'Corps du message' })).toContainText(
    'Carol-signature',
  );
  await expectNoExecution(page, dialogs);
  await dialog.getByRole('button', { name: 'Envoyer' }).click();
  await expect(page.getByText('Message envoyé.')).toBeVisible();

  // Réception : le message est affiché dans le cadre isolé.
  const row = page.getByRole('button').filter({ hasText: subject });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const frame = page.frameLocator('iframe[title="Contenu du message"]');
  await expect(frame.getByText('Carol-signature')).toBeVisible();
  await expectNoExecution(page, dialogs);

  await patchPreferences(page, { signatureHtml: '' });
});
