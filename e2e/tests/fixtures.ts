import { expect, test as base, type Page } from '@playwright/test';

export const USER = { email: 'sacha@exemple.com', password: 'e2e-password' };

/**
 * Chaque test échoue si la page enfreint la CSP ou si une charge XSS s'exécute
 * (les charges de test posent window.__xss).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: async ({ page }, use) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await use(violations);
    expect(violations, 'violations de la CSP').toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss),
    ).toBeUndefined();
  },
});

export async function login(page: Page, email = USER.email, password = USER.password) {
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

export { expect };

/** Déconnexion : le bouton est dans la navigation des paramètres. */
export async function logout(page: Page) {
  await page.goto('/parametres');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
}

/** Préférences par défaut (langue française, thème automatique…), via l'API avec la session. */
export async function resetPreferences(page: Page) {
  // La connexion doit être terminée (cookie de session posé).
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
  const session = await page.request.get('/api/v1/auth/session');
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const origin = new URL(page.url()).origin;
  const res = await page.request.patch('/api/v1/me/preferences', {
    headers: { 'x-csrf-token': csrfToken, origin },
    data: { theme: 'auto', accent: 'indigo', density: 'comfortable', language: 'fr' },
  });
  expect(res.status()).toBe(200);
  await page.reload();
}
