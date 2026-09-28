import { seedMailbox, type StartedGreenMail } from '@plume/testing';
import { expect, login, test } from './fixtures.js';

const DAVE = { email: 'dave@exemple.com', password: 'e2e-password-dave' };
const greenmail = {
  host: process.env.PLUME_E2E_IMAP_HOST ?? '127.0.0.1',
  imapsPort: Number(process.env.PLUME_E2E_IMAP_PORT ?? 3993),
} as StartedGreenMail;

/** PDF minimal valide (deux pages A4, un rectangle), avec une table xref correcte. */
function minimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
  ];
  const stream = '0 0 1 rg 20 20 160 160 re f';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test.describe.configure({ mode: 'serial' });

const tag = `s6-${Date.now()}`;

test.beforeAll(async () => {
  await seedMailbox(greenmail, DAVE, [
    {
      subject: `${tag} facture PDF`,
      text: 'Ci-joint la facture.',
      attachments: [
        { filename: 'facture.pdf', content: minimalPdf(), contentType: 'application/pdf' },
      ],
    },
    { subject: `${tag} à reporter`, text: 'x' },
    { subject: `${tag} à libeller`, text: 'x' },
    { subject: `${tag} à glisser`, text: 'x' },
    { subject: `${tag} classé`, text: 'x', folder: 'Classement' },
    { subject: `${tag} spam`, text: 'x' },
    {
      subject: `${tag} ${'INDESIRABLE'.repeat(30)}`,
      from: `"${'Promo'.repeat(30)}" <${'x'.repeat(60)}@spam.example>`,
      text: 'x',
      flags: ['Libelle-tres-long-pour-une-offre-promotionnelle-exceptionnelle'],
    },
    {
      subject: `${tag} newsletter`,
      html:
        '<html><head><style>html,body{height:100%;overflow:auto}</style></head>' +
        '<body style="height:100%;overflow-y:scroll"><table height="100%" style="height:100%">' +
        Array.from({ length: 50 }, (_, i) => `<tr><td>Ligne ${i + 1}</td></tr>`).join('') +
        '<tr><td>FIN NEWSLETTER</td></tr></table></body></html>',
    },
    {
      subject: `${tag} long`,
      html:
        Array.from({ length: 60 }, (_, i) => `<p>Paragraphe ${i + 1} du mail long.</p>`).join('') +
        '<p>FIN DU MAIL</p>',
    },
  ]);
});

test('aperçu PDF dans la visionneuse isolée (origine opaque)', async ({ page, cspViolations }) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  await page
    .getByRole('button')
    .filter({ hasText: `${tag} facture PDF` })
    .click();
  await page.getByRole('button', { name: 'Aperçu' }).click();
  const viewer = page.getByTitle('Aperçu de facture.pdf');
  await expect(viewer).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frameLocator('iframe[title="Aperçu de facture.pdf"]');
  await expect(frame.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator('#count')).toHaveText('2');
  await expect(frame.getByRole('spinbutton', { name: 'Page' })).toHaveValue('1');
  await expect(frame.getByRole('button', { name: 'Page précédente' })).toBeDisabled();
  // Zoom et accès direct à une page.
  const zoom = frame.locator('#zoom');
  const fitted = await zoom.textContent();
  await frame.getByRole('button', { name: 'Zoom avant' }).click();
  await expect(zoom).not.toHaveText(fitted ?? '');
  await frame.getByRole('button', { name: 'Ajuster à la largeur' }).click();
  await expect(zoom).toHaveText(fitted ?? '');
  await frame.getByRole('spinbutton', { name: 'Page' }).fill('2');
  await frame.getByRole('spinbutton', { name: 'Page' }).press('Enter');
  await expect(frame.getByRole('button', { name: 'Page suivante' })).toBeDisabled();
  await expect(frame.getByRole('img', { name: 'Page 2 sur 2' })).toBeInViewport();
  // La visionneuse n'a accès ni aux cookies ni au stockage de l'application.
  const viewerFrame = page.frames().find((f) => f.url().endsWith('/viewer/pdf.html'));
  expect(viewerFrame).toBeDefined();
  expect(await viewerFrame!.evaluate(() => window.origin)).toBe('null');
  expect(
    await viewerFrame!.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        return 'inaccessible';
      }
    }),
  ).not.toContain('plume');
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();
});

test('libeller puis retrouver le message par la barre latérale', async ({
  page,
  cspViolations,
}) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  await page
    .getByRole('button')
    .filter({ hasText: `${tag} à libeller` })
    .click();
  await page.getByRole('button', { name: 'Libellés' }).click();
  await page.getByPlaceholder('Ajouter un libellé').fill('Projet-S6');
  await page.getByPlaceholder('Ajouter un libellé').press('Enter');
  const sidebarLabel = page.getByRole('link', { name: 'Projet-S6' });
  await expect(sidebarLabel).toBeVisible();
  await sidebarLabel.click();
  await expect(page.getByRole('button').filter({ hasText: `${tag} à libeller` })).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: `${tag} à reporter` })).toHaveCount(0);
});

test('reporter, retrouver dans « Reportés », puis annuler le report', async ({
  page,
  cspViolations,
}) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  const row = page.getByRole('button').filter({ hasText: `${tag} à reporter` });
  await row.click();
  await page.getByRole('button', { name: 'Reporter le message' }).click();
  await page.getByRole('menuitem', { name: 'Demain, 8 h' }).click();
  await expect(page.getByText(/Message reporté au/)).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.getByRole('link', { name: 'Reportés' }).click();
  await page
    .getByRole('button')
    .filter({ hasText: `${tag} à reporter` })
    .click();
  await expect(page.getByText(/Reporté jusqu’au/)).toBeVisible();
  await page.getByRole('button', { name: 'Annuler le report' }).click();
  await expect(page.getByText('Action annulée.')).toBeVisible();

  await page.getByRole('link', { name: /réception/i }).click();
  await expect(page.getByRole('button').filter({ hasText: `${tag} à reporter` })).toBeVisible();
});

for (const [kind, title] of [
  ['long', 'un mail long'],
  ['newsletter', 'une newsletter qui fixe html/body à 100 % et overflow: auto'],
] as const) {
  test(`${title} s’affiche en entier, avec le seul défilement du panneau`, async ({
    page,
    cspViolations,
  }) => {
    void cspViolations;
    await login(page, DAVE.email, DAVE.password);
    await page
      .getByRole('button')
      .filter({ hasText: `${tag} ${kind}` })
      .click();
    const iframe = page.getByTitle('Contenu du message');
    await expect(iframe).toHaveAttribute('data-sized', 'true');
    const frame = page.frames().find((f) => f.url().includes('/body'))!;
    // L'iframe a la hauteur de son contenu : aucun défilement interne.
    await expect
      .poll(async () => {
        const inner = await frame.evaluate(() => ({
          scroll: document.documentElement.scrollHeight,
          client: document.documentElement.clientHeight,
        }));
        return inner.scroll <= inner.client;
      })
      .toBe(true);
    const height = (await iframe.boundingBox())!.height;
    expect(height).toBeGreaterThan(1000);
    // La fin du mail est atteinte en faisant défiler le panneau de lecture.
    const end = frame.getByText(kind === 'long' ? 'FIN DU MAIL' : 'FIN NEWSLETTER');
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
      await page.evaluate(() => window.innerHeight),
    );
  });
}

test('un sujet ou un expéditeur sans espace ne crée pas de défilement horizontal', async ({
  page,
  cspViolations,
}) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  await expect(page.getByRole('button').filter({ hasText: `${tag} INDESIRABLE` })).toBeVisible();
  const list = page.locator('[class*=listScroll]');
  const { scroll, client } = await list.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(scroll).toBe(client);
  // Barre latérale : le nom de libellé très long est tronqué.
  const sidebar = page.getByRole('navigation', { name: 'Dossiers et libellés' });
  const widths = await sidebar.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(widths.scroll).toBe(widths.client);
});

test('fenêtre étroite : le message ouvert se glisse par son titre vers un dossier', async ({
  page,
  cspViolations,
}) => {
  void cspViolations;
  // ≤ 1100 px : ouvrir un message masque la liste ; seul le titre reste à faire glisser.
  await page.setViewportSize({ width: 1000, height: 760 });
  await login(page, DAVE.email, DAVE.password);
  await page
    .getByRole('button')
    .filter({ hasText: `${tag} à glisser` })
    .click();
  await expect(page.locator('#preview-subject')).toHaveText(`${tag} à glisser`);
  await expect(page.getByRole('button').filter({ hasText: `${tag} à glisser` })).toBeHidden();
  await page.locator('#preview-subject').dragTo(page.getByRole('link', { name: 'Classement' }));
  await expect(page.getByText('Message déplacé.')).toBeVisible();
  await page.getByRole('link', { name: 'Classement' }).click();
  await expect(page.getByRole('button').filter({ hasText: `${tag} à glisser` })).toBeVisible();
});

test('signaler comme indésirable, puis « Pas un indésirable »', async ({ page, cspViolations }) => {
  void cspViolations;
  await login(page, DAVE.email, DAVE.password);
  await page
    .getByRole('button')
    .filter({ hasText: `${tag} spam` })
    .click();
  await page.getByRole('button', { name: 'Signaler comme indésirable' }).click();
  await expect(page.getByText('Message déplacé dans les indésirables.')).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: `${tag} spam` })).toHaveCount(0);

  await page.getByRole('link', { name: 'Indésirables' }).click();
  await page
    .getByRole('button')
    .filter({ hasText: `${tag} spam` })
    .click();
  await page.getByRole('button', { name: /^Pas un indésirable/ }).click();
  await expect(page.getByText('Message déplacé.')).toBeVisible();
  await page.getByRole('link', { name: /Boîte de réception/ }).click();
  await expect(page.getByRole('button').filter({ hasText: `${tag} spam` })).toBeVisible();
});
