import { seedMailbox, type StartedGreenMail } from '@plume/testing';
import { XSS_PAYLOADS } from '../../packages/mail/test/fixtures/xss-corpus.js';
import { expect, login, test } from './fixtures.js';

const BOB = { email: 'bob@exemple.com', password: 'e2e-password-bob' };
// GreenMail de la pile E2E, exposé en local (IMAPS) pour déposer des messages.
const greenmail = {
  host: process.env.PLUME_E2E_IMAP_HOST ?? '127.0.0.1',
  imapsPort: Number(process.env.PLUME_E2E_IMAP_PORT ?? 3993),
} as StartedGreenMail;

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3d1a1e30000000049454e44ae426082',
  'hex',
);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const tag = `run-${Date.now()}`;
  await seedMailbox(greenmail, BOB, [
    // Une charge par message dans le sujet et le nom d'expéditeur.
    ...XSS_PAYLOADS.slice(0, 40).map((payload, i) => ({
      subject: `${tag} S${i} ${payload}`,
      from: { name: payload, address: 'attaquant@evil.example' } as unknown as string,
      text: 'corps',
    })),
    // Toutes les charges dans le corps HTML et les noms de pièces jointes.
    {
      subject: `${tag} corps HTML piégé`,
      html: `<p>Début</p><img src="https://tracker.example/p.gif">${XSS_PAYLOADS.join('\n')}<p>Fin</p>`,
      // GreenMail (serveur de test) ne sait pas analyser un nom de fichier contenant « ; » : ces
      // charges restent couvertes par les tests unitaires du nettoyage des noms de fichiers.
      attachments: XSS_PAYLOADS.filter((p) => !p.includes(';'))
        .slice(0, 15)
        .map((payload, i) => ({
          filename: `${payload}-${i}.txt`,
          content: 'x',
          contentType: 'text/plain',
        })),
    },
    {
      subject: `${tag} image intégrée`,
      html: '<p>Logo :</p><img src="cid:logo@plume" alt="logo">',
      attachments: [
        { filename: 'logo.png', content: PNG, contentType: 'image/png', cid: 'logo@plume' },
      ],
    },
  ]);
});

test('aucune charge XSS ne s’exécute (sujets, expéditeurs, corps, pièces jointes)', async ({
  page,
  cspViolations,
}) => {
  test.setTimeout(180_000);
  void cspViolations;
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await login(page, BOB.email, BOB.password);
  await expect(page.getByText(/corps HTML piégé/).first()).toBeVisible();

  // Ouvre le message au corps piégé et vérifie le cadre isolé.
  await page
    .getByText(/corps HTML piégé/)
    .first()
    .click();
  const frameElement = page.getByTitle('Contenu du message');
  await expect(frameElement).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-popups allow-popups-to-escape-sandbox',
  );
  const frame = page.frameLocator('iframe[title="Contenu du message"]');
  await expect(frame.getByText('Début')).toBeVisible();
  await expect(page.getByText(/image\(s\) distante\(s\) bloquée\(s\)/)).toBeVisible();

  for (const f of page.frames()) {
    expect(
      await f.evaluate(() => (window as unknown as { __xss?: unknown }).__xss),
    ).toBeUndefined();
  }

  // Parcourt les messages dont le sujet et l'expéditeur sont piégés.
  const rows = page.locator('ul li button').filter({ hasText: / S\d+ / });
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(40);
  for (let i = 0; i < count; i++) {
    await rows.nth(i).click();
    await expect(page.locator('#preview-subject')).toBeVisible({ timeout: 15_000 });
  }

  expect(dialogs).toEqual([]);
  for (const f of page.frames()) {
    expect(
      await f.evaluate(() => (window as unknown as { __xss?: unknown }).__xss),
    ).toBeUndefined();
  }
});

test('affiche les images intégrées (cid:) dans le cadre isolé', async ({ page, cspViolations }) => {
  void cspViolations;
  await login(page, BOB.email, BOB.password);
  await page
    .getByText(/image intégrée/)
    .first()
    .click();
  const frame = page.frameLocator('iframe[title="Contenu du message"]');
  const image = frame.getByRole('img', { name: 'logo' });
  await expect(image).toBeVisible();
  await expect
    .poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
});

test('se met à jour en temps réel à l’arrivée d’un message', async ({ page, cspViolations }) => {
  void cspViolations;
  await login(page, BOB.email, BOB.password);
  await expect(page.getByText(/image intégrée/).first()).toBeVisible();
  const subject = `Arrivé en direct ${Date.now()}`;
  // Laisse au flux SSE le temps de s'établir.
  await page.waitForTimeout(1500);
  await seedMailbox(greenmail, BOB, [{ subject, text: 'bonjour' }]);
  await expect(page.getByText(subject)).toBeVisible({ timeout: 20_000 });
});
