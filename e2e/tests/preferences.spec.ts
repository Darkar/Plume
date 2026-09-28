import { expect, login, resetPreferences, test } from './fixtures.js';

const DAVE = { email: 'dave@exemple.com', password: 'e2e-password-dave' };

test('langue, thème sans flash au rechargement, et photo réencodée', async ({
  page,
  cspViolations,
}) => {
  test.setTimeout(90_000);
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  await resetPreferences(page);
  await page.getByRole('link', { name: 'Paramètres' }).click();

  // Langue anglaise, appliquée immédiatement.
  await page.getByLabel('Langue').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Thème sombre et accent vert : appliqués dès le premier rendu après rechargement (script en
  // ligne autorisé par son empreinte CSP ; aucune violation de CSP n'est tolérée par le test).
  const isPatch = (r: { url(): string; request(): { method(): string } }) =>
    r.url().endsWith('/me/preferences') && r.request().method() === 'PATCH';
  const darkSaved = page.waitForResponse(isPatch);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await darkSaved;
  const greenSaved = page.waitForResponse(isPatch);
  await page.getByRole('radio', { name: 'Green' }).click();
  await greenSaved;
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'green');
  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('html[data-theme="dark"][data-accent="green"]', { timeout: 2_000 });

  // Photo : un PNG généré dans le navigateur, réencodé en WebP par le serveur.
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#137236';
    context.fillRect(0, 0, 400, 300);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/png'),
    );
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByLabel('Change photo').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png),
  });
  await expect(page.getByText('Photo saved.')).toBeVisible();
  const avatar = await page.request.get('/api/v1/me/avatar');
  expect(avatar.headers()['content-type']).toBe('image/webp');

  // Retour aux réglages initiaux.
  await page.getByRole('button', { name: 'Remove the photo' }).click();
  await expect(page.getByRole('button', { name: 'Remove the photo' })).toHaveCount(0);
  await resetPreferences(page);
  await expect(page.getByRole('heading', { name: 'Paramètres', level: 1 })).toBeVisible();
});
