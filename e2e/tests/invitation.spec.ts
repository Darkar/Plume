import { seedMailbox, type StartedGreenMail } from '@plume/testing';
import { expect, login, test } from './fixtures.js';

const DAVE = { email: 'dave@exemple.com', password: 'e2e-password-dave' };
const ALICE = { email: 'alice@exemple.com', password: 'e2e-password-alice' };
const greenmail = {
  host: process.env.PLUME_E2E_IMAP_HOST ?? '127.0.0.1',
  imapsPort: Number(process.env.PLUME_E2E_IMAP_PORT ?? 3993),
} as StartedGreenMail;

const tag = `inv-${Date.now()}`;

/** Invitation envoyée par Alice à Dave (format des agendas courants : partie text/calendar). */
function invitation(): string {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Exemple//Agenda//FR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${tag}@exemple.com`,
    'SEQUENCE:0',
    'DTSTAMP:20261001T080000Z',
    'DTSTART:20261015T120000Z',
    'DTEND:20261015T130000Z',
    `SUMMARY:Reunion ${tag}`,
    'LOCATION:Salle 3',
    'DESCRIPTION:<script>window.__xss=1</script>Ordre du jour',
    'ORGANIZER;CN=Alice:mailto:alice@exemple.com',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Dave:mailto:dave@exemple.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return [
    'From: Alice <alice@exemple.com>',
    'To: dave@exemple.com',
    `Subject: Invitation ${tag}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Vous etes invite.',
    '--b1',
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
    '',
    ics,
    '--b1--',
    '',
  ].join('\r\n');
}

test('invitation : carte de l’événement, réponse « Oui » reçue par l’organisateur', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  await seedMailbox(greenmail, DAVE, [{ raw: invitation() }]);

  const dave = await browser.newPage();
  await login(dave, DAVE.email, DAVE.password);
  await dave
    .getByRole('button')
    .filter({ hasText: `Invitation ${tag}` })
    .click();
  const card = dave.getByRole('region', { name: `Reunion ${tag}` });
  await expect(card).toBeVisible();
  await expect(card.getByText('Salle 3')).toBeVisible();
  await expect(card.getByText('Organisé par Alice <alice@exemple.com>')).toBeVisible();
  // La description reste du texte : rien ne s'exécute.
  await card.getByText('Détails de l’événement').click();
  await expect(card.getByText('<script>window.__xss=1</script>Ordre du jour')).toBeVisible();
  expect(
    await dave.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();

  await card.getByRole('button', { name: 'Oui' }).click();
  await expect(dave.getByText('Réponse envoyée à Alice.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Oui' })).toHaveAttribute('aria-pressed', 'true');
  // Réponse mémorisée : toujours affichée après rechargement, sans libellé technique.
  await dave.reload();
  await expect(
    dave.getByRole('region', { name: `Reunion ${tag}` }).getByRole('button', { name: 'Oui' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(dave.getByText('$PlumeAccepted')).toHaveCount(0);
  await dave.close();

  // L'organisatrice reçoit la réponse (iMIP), avec la carte « Réponse à une invitation ».
  const alice = await browser.newPage();
  await login(alice, ALICE.email, ALICE.password);
  const reply = alice.getByRole('button').filter({ hasText: `Accepté : Reunion ${tag}` });
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await reply.click();
  const answer = alice.getByRole('region', { name: `Reunion ${tag}` });
  await expect(answer.getByText('Réponse à une invitation')).toBeVisible();
  // Sans nom d'affichage, la réponse porte l'adresse du participant.
  await expect(answer.getByText('dave@exemple.com a accepté')).toBeVisible();
  await alice.close();
});
