import { expect, login, logout, test, USER } from './fixtures.js';

test.describe('authentification', () => {
  test('connexion puis déconnexion', async ({ page, cspViolations }) => {
    void cspViolations;
    await login(page);
    await expect(page.getByRole('searchbox', { name: 'Rechercher' })).toBeVisible();
    await expect(page.getByText(USER.email)).toBeVisible();

    const cookies = await page.context().cookies();
    const sid = cookies.find((c) => c.name === '__Host-plume_sid');
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.secure).toBe(true);
    expect(sid?.sameSite).toBe('Strict');
    // Le cookie de session n'est pas lisible par JavaScript.
    expect(await page.evaluate(() => document.cookie)).not.toContain('plume_sid');

    await logout(page);
    await expect(page.getByRole('heading', { name: 'Bon retour.' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Bon retour.' })).toBeVisible();
  });

  test('refuse un mauvais mot de passe et un domaine non autorisé avec le même message', async ({
    page,
    cspViolations,
  }) => {
    void cspViolations;
    // Adresse différente à chaque exécution : le verrouillage anti-force brute (voulu) ne doit
    // pas dépendre des exécutions précédentes.
    await login(page, `inconnu-${Date.now()}@exemple.com`, 'mauvais');
    await expect(page.getByRole('alert')).toHaveText('Identifiants invalides.');
    await login(page, 'quelquun@evil.example', 'x');
    await expect(page.getByRole('alert')).toHaveText('Identifiants invalides.');
  });

  test('applique les en-têtes de sécurité', async ({ page }) => {
    const response = await page.goto('/connexion');
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['strict-transport-security']).toContain('max-age=63072000');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
  });
});
