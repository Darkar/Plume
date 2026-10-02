import { ImapFlow } from 'imapflow';
import { loginFor, serverFor, verifyImapLogin } from '@plume/mail';
import { seedMailbox, startGreenMail, type StartedGreenMail } from '@plume/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  client,
  createTestApp,
  login,
  resetInfra,
  startInfra,
  testConfig,
  type Client,
  type Infra,
  type TestApp,
} from './support/harness.js';

const SACHA = { email: 'sacha@exemple.com', password: 'imap-sacha' };
const ALICE = { email: 'alice@exemple.com', password: 'imap-alice' };
/** Compte du relais SMTP commun au domaine (identifiants distincts de ceux des boîtes). */
const RELAY = { email: 'relais@exemple.com', password: 'relais-secret' };

let infra: Infra;
let gm: StartedGreenMail;
let t: TestApp;
let sacha: Client;
let alice: Client;

beforeAll(async () => {
  [infra, gm] = await Promise.all([startInfra(), startGreenMail([SACHA, ALICE, RELAY])]);
  await resetInfra(infra);
  await seedMailbox(gm, SACHA, [
    { subject: 'Premier', text: 'a', headers: { 'Message-ID': '<premier@exemple.fr>' } },
    { subject: 'Deuxième', text: 'b' },
    { subject: 'Troisième', text: 'c' },
    { subject: 'Quatrième', text: 'd' },
    { subject: 'Promo douteuse', text: 'gagnez' },
  ]);
  await seedMailbox(gm, ALICE, [{ subject: 'Message d’Alice', text: 'x' }]);
  const config = testConfig((raw) => {
    raw.domains[0].imap = { host: gm.host, port: gm.imapsPort, security: 'tls' };
    raw.domains[0].smtp = { host: gm.host, port: gm.smtpsPort, security: 'tls' };
    raw.domains[0].tls = { reject_unauthorized: false };
    raw.security.max_attachment_size = '1MB';
    raw.security.max_upload_total = '2MB';
  });
  t = await createTestApp(infra, {
    config,
    verifyLogin: (domain, email, password) =>
      verifyImapLogin(serverFor(domain, 'imap'), loginFor(domain, email), password),
  });
  sacha = client(t.app);
  alice = client(t.app);
  await login(sacha, SACHA.email, SACHA.password);
  await login(alice, ALICE.email, ALICE.password);
});

afterAll(async () => {
  await t?.app.close();
  await Promise.all([infra?.stop(), gm?.stop()]);
});

async function find(c: Client, subject: string, folder = 'INBOX') {
  const res = await c.request(
    'GET',
    `/api/v1/messages?folder=${encodeURIComponent(folder)}&limit=100`,
  );
  return (
    res.json().messages as {
      id: string;
      subject: string;
      seen: boolean;
      flagged: boolean;
      answered: boolean;
      keywords: string[];
    }[]
  ).find((m) => m.subject === subject);
}

/** Lecture directe dans GreenMail (hors de Plume) pour vérifier les effets. */
async function rawImap<T>(
  user: { email: string; password: string },
  fn: (c: ImapFlow) => Promise<T>,
) {
  const c = new ImapFlow({
    host: gm.host,
    port: gm.imapsPort,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: user.email, pass: user.password },
    logger: false,
    disableBinary: true,
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}

/** Source du dernier message de la boîte contenant le texte donné (délivrance asynchrone). */
async function latestSource(
  user: { email: string; password: string },
  needle: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = await rawImap(user, async (c) => {
      await c.mailboxOpen('INBOX');
      const sources: string[] = [];
      for await (const msg of c.fetch('1:*', { source: true }))
        sources.push(msg.source!.toString());
      return sources.reverse().find((s) => s.includes(needle));
    });
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`message « ${needle} » non délivré`);
}

describe('drapeaux et libellés', () => {
  it('marque non lu, favori, et ajoute / retire des libellés', async () => {
    const msg = (await find(sacha, 'Premier'))!;
    expect(
      (
        await sacha.request('PATCH', `/api/v1/messages/${msg.id}`, {
          seen: true,
          flagged: true,
          labels: { add: ['Factures', 'Urgent'] },
        })
      ).statusCode,
    ).toBe(204);
    let after = (await find(sacha, 'Premier'))!;
    expect(after).toMatchObject({ seen: true, flagged: true });
    expect(after.keywords.sort()).toEqual(['Factures', 'Urgent']);
    await sacha.request('PATCH', `/api/v1/messages/${msg.id}`, {
      seen: false,
      labels: { remove: ['Urgent'] },
    });
    after = (await find(sacha, 'Premier'))!;
    expect(after.seen).toBe(false);
    expect(after.keywords).toEqual(['Factures']);
  });

  it.each([
    [{ labels: { add: ['avec espace'] } }, 400],
    [{ labels: { add: ['\\Deleted'] } }, 400],
    [{ labels: { add: ['Seen'] } }, 400],
    [{}, 400],
    [{ seen: 'oui' }, 400],
    [{ flags: ['\\Deleted'] }, 400],
  ])('refuse %j', async (body, status) => {
    const msg = (await find(sacha, 'Premier'))!;
    expect((await sacha.request('PATCH', `/api/v1/messages/${msg.id}`, body)).statusCode).toBe(
      status,
    );
  });

  it('exige le jeton CSRF', async () => {
    const msg = (await find(sacha, 'Premier'))!;
    const res = await sacha.request(
      'PATCH',
      `/api/v1/messages/${msg.id}`,
      { seen: true },
      { 'x-csrf-token': 'faux' },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('déplacement, archivage, corbeille', () => {
  it('archive puis annule (retour au dossier d’origine)', async () => {
    const msg = (await find(sacha, 'Deuxième'))!;
    const res = await sacha.request('POST', `/api/v1/messages/${msg.id}/archive`);
    expect(res.statusCode).toBe(200);
    const { id, folder, from } = res.json();
    expect(folder).toBe('Archives');
    expect(from).toBe('INBOX');
    expect(await find(sacha, 'Deuxième')).toBeUndefined();
    expect((await sacha.request('GET', `/api/v1/messages/${id}`)).json().subject).toBe('Deuxième');

    const undo = await sacha.request('POST', `/api/v1/messages/${id}/move`, { folder: 'INBOX' });
    expect(undo.statusCode).toBe(200);
    expect(await find(sacha, 'Deuxième')).toBeDefined();
  });

  it('signale comme indésirable (dossier Junk créé), puis remet dans la boîte', async () => {
    const msg = (await find(sacha, 'Promo douteuse'))!;
    const res = await sacha.request('POST', `/api/v1/messages/${msg.id}/junk`);
    expect(res.statusCode).toBe(200);
    const { id, folder, from } = res.json();
    expect(folder).toBe('Junk');
    expect(from).toBe('INBOX');
    expect(await find(sacha, 'Promo douteuse')).toBeUndefined();
    expect(await find(sacha, 'Promo douteuse', 'Junk')).toBeDefined();
    // Un second signalement réutilise le même dossier.
    const folders = (await sacha.request('GET', '/api/v1/folders')).json().folders as {
      path: string;
    }[];
    expect(folders.filter((f) => f.path === 'Junk')).toHaveLength(1);

    const back = await sacha.request('POST', `/api/v1/messages/${id}/move`, { folder: 'INBOX' });
    expect(back.statusCode).toBe(200);
    expect(await find(sacha, 'Promo douteuse')).toBeDefined();
  });

  it('refuse de signaler le message d’un autre compte', async () => {
    const msg = (await find(sacha, 'Troisième'))!;
    const res = await alice.request('POST', `/api/v1/messages/${msg.id}/junk`);
    expect(res.statusCode).not.toBe(200);
    expect(await find(sacha, 'Troisième')).toBeDefined();
  });

  it('refuse un dossier inexistant ou identique', async () => {
    const msg = (await find(sacha, 'Troisième'))!;
    expect(
      (await sacha.request('POST', `/api/v1/messages/${msg.id}/move`, { folder: 'Nulle/Part' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await sacha.request('POST', `/api/v1/messages/${msg.id}/move`, { folder: 'INBOX' }))
        .statusCode,
    ).toBe(400);
  });

  it('supprime vers la corbeille, puis définitivement depuis la corbeille', async () => {
    const msg = (await find(sacha, 'Quatrième'))!;
    const first = (await sacha.request('DELETE', `/api/v1/messages/${msg.id}`)).json();
    expect(first.permanent).toBe(false);
    const trash = (await sacha.request('GET', '/api/v1/folders'))
      .json()
      .folders.find((f: { path: string }) => f.path === 'Trash');
    expect(trash.total).toBe(1);
    const second = (await sacha.request('DELETE', `/api/v1/messages/${first.id}`)).json();
    expect(second.permanent).toBe(true);
    expect(await find(sacha, 'Quatrième', 'Trash')).toBeUndefined();
  });

  it('un identifiant d’un autre compte n’agit jamais sur ce compte', async () => {
    const msg = (await find(sacha, 'Troisième'))!;
    await alice.request('PATCH', `/api/v1/messages/${msg.id}`, { flagged: true });
    await alice.request('POST', `/api/v1/messages/${msg.id}/archive`);
    await alice.request('DELETE', `/api/v1/messages/${msg.id}`);
    const still = (await find(sacha, 'Troisième'))!;
    expect(still.flagged).toBe(false);
  });
});

describe('envoi', () => {
  it('envoie, dépose dans « Envoyés » et délivre au destinataire', async () => {
    const res = await sacha.request('POST', '/api/v1/messages/send', {
      to: [{ name: 'Alice', address: 'Alice@Exemple.com' }],
      bcc: [{ name: '', address: 'cache@exemple.fr' }],
      subject: 'Réunion\r\nBcc: victime@evil.example',
      html: '<p>Bonjour <b>Alice</b></p><script>alert(1)</script>',
      attachments: [
        {
          filename: '../notes.txt',
          contentType: 'text/plain',
          data: Buffer.from('notes').toString('base64'),
        },
      ],
    });
    expect(res.statusCode).toBe(200);

    const received = await latestSource(ALICE, 'Bonjour');
    const head = received.slice(0, received.indexOf('\r\n\r\n'));
    expect(head).toContain('From: sacha@exemple.com');
    expect(head).not.toMatch(/^Bcc:/im);
    expect(received).not.toContain('cache@exemple.fr');
    expect(received).not.toContain('<script>');
    expect(received).not.toContain('victime@evil.example\r\n');

    const sent = await find(sacha, 'Réunion Bcc: victime@evil.example', 'Sent');
    expect(sent?.seen).toBe(true);
  });

  it('répond avec les en-têtes de fil lus sur le serveur', async () => {
    const original = (await find(sacha, 'Premier'))!;
    const res = await sacha.request('POST', '/api/v1/messages/send', {
      to: [{ address: 'alice@exemple.com' }],
      subject: 'Re: Premier',
      html: '<p>Réponse</p>',
      inReplyTo: original.id,
    });
    expect(res.statusCode).toBe(200);
    const source = await latestSource(ALICE, 'Subject: Re: Premier');
    expect(source).toContain('In-Reply-To: <premier@exemple.fr>');
    expect((await find(sacha, 'Premier'))?.answered).toBe(true);
  });

  it.each([
    [{ to: [] }, 'aucun destinataire'],
    [{ to: [{ address: 'pas-une-adresse' }] }, 'adresse invalide'],
    [{ to: [{ address: 'a@exemple.fr\r\nRCPT TO:<x@evil.example>' }] }, 'CRLF dans l’adresse'],
    [{ to: [{ address: 'a@exemple.fr' }], headers: { 'X-Test': '1' } }, 'en-têtes libres'],
    [{ to: [{ address: 'a@exemple.fr' }], from: 'patron@exemple.com' }, 'expéditeur imposé'],
    [{ to: [{ address: 'a@exemple.fr' }], inReplyTo: 'forgé' }, 'réponse forgée'],
    [
      { to: Array.from({ length: 101 }, (_, i) => ({ address: `u${i}@exemple.fr` })) },
      'trop de destinataires',
    ],
  ] as [Record<string, unknown>, string][])(
    'refuse une requête invalide (%j, %s)',
    async (body) => {
      const res = await sacha.request('POST', '/api/v1/messages/send', {
        subject: 's',
        html: 'x',
        ...body,
      });
      expect(res.statusCode).toBe(400);
    },
  );

  describe('relais SMTP commun au domaine', () => {
    const withRelay = async (password: string, fn: () => Promise<void>) => {
      const original = t.config.current;
      const domain = original.domains[0]!;
      process.env.PLUME_TEST_SMTP_RELAY = password;
      t.config.current = {
        ...original,
        domains: [
          {
            ...domain,
            smtp: {
              ...domain.smtp,
              auth: {
                username: RELAY.email,
                password: { kind: 'env', name: 'PLUME_TEST_SMTP_RELAY' },
              },
            },
          },
        ],
      };
      try {
        await fn();
      } finally {
        t.config.current = original;
        delete process.env.PLUME_TEST_SMTP_RELAY;
      }
    };

    it('envoie avec les identifiants du relais, expéditeur inchangé', async () => {
      await withRelay(RELAY.password, async () => {
        const res = await sacha.request('POST', '/api/v1/messages/send', {
          to: [{ address: 'alice@exemple.com' }],
          subject: 'Par le relais',
          html: '<p>Relayé</p>',
        });
        expect(res.statusCode).toBe(200);
      });
      const source = await latestSource(ALICE, 'Subject: Par le relais');
      expect(source).toContain('From: sacha@exemple.com');
    });

    it('relais refusé : erreur de service, pas d’erreur d’identifiants utilisateur', async () => {
      await withRelay('mauvais-mot-de-passe', async () => {
        const res = await sacha.request('POST', '/api/v1/messages/send', {
          to: [{ address: 'alice@exemple.com' }],
          subject: 'Refusé',
          html: 'x',
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('smtp_unavailable');
      });
    });

    it('secret du relais absent : erreur de service', async () => {
      await withRelay('', async () => {
        const res = await sacha.request('POST', '/api/v1/messages/send', {
          to: [{ address: 'alice@exemple.com' }],
          subject: 'Sans secret',
          html: 'x',
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('smtp_unavailable');
      });
    });
  });

  it('limite la taille des pièces jointes', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10).toString('base64');
    const res = await sacha.request('POST', '/api/v1/messages/send', {
      to: [{ address: 'alice@exemple.com' }],
      subject: 'gros',
      html: 'x',
      attachments: [{ filename: 'gros.bin', data: big }],
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('brouillons', () => {
  it('enregistre, relit, remplace puis envoie un brouillon (supprimé après envoi)', async () => {
    const first = await sacha.request('POST', '/api/v1/messages/drafts', {
      to: [{ name: 'Alice', address: 'alice@exemple.com' }],
      bcc: [{ name: '', address: 'cache@exemple.org' }],
      subject: 'Brouillon v1',
      html: '<p>Première version</p><script>alert(1)</script>',
    });
    expect(first.statusCode).toBe(200);
    const id1 = first.json().id as string;
    expect(id1).toBeTruthy();

    const saved = (await find(sacha, 'Brouillon v1', 'Drafts')) as { id: string; draft?: boolean };
    expect(saved?.draft).toBe(true);
    const detail = (await sacha.request('GET', `/api/v1/messages/${id1}`)).json();
    expect(detail.to).toEqual([{ name: 'Alice', address: 'alice@exemple.com' }]);
    expect(detail.bcc).toEqual([{ name: '', address: 'cache@exemple.org' }]);
    const body = (await sacha.request('GET', `/api/v1/messages/${id1}/draft`)).json();
    expect(body.html).toContain('Première version');
    expect(body.html).not.toContain('<script');

    const second = await sacha.request('POST', '/api/v1/messages/drafts', {
      to: [{ name: 'Alice', address: 'alice@exemple.com' }],
      subject: 'Brouillon v2',
      html: '<p>Seconde version</p>',
      replaces: id1,
    });
    expect(second.statusCode).toBe(200);
    const id2 = second.json().id as string;
    expect(await find(sacha, 'Brouillon v1', 'Drafts')).toBeUndefined();
    expect(await find(sacha, 'Brouillon v2', 'Drafts')).toBeDefined();

    const sent = await sacha.request('POST', '/api/v1/messages/send', {
      to: [{ name: 'Alice', address: 'alice@exemple.com' }],
      subject: 'Brouillon v2',
      html: '<p>Seconde version</p>',
      draftId: id2,
    });
    expect(sent.statusCode).toBe(200);
    expect(await find(sacha, 'Brouillon v2', 'Drafts')).toBeUndefined();
    await latestSource(ALICE, 'Subject: Brouillon v2');
  });

  it('accepte un brouillon sans destinataire', async () => {
    const res = await sacha.request('POST', '/api/v1/messages/drafts', {
      subject: 'Idée en vrac',
      html: '<p>À compléter</p>',
    });
    expect(res.statusCode).toBe(200);
    expect(await find(sacha, 'Idée en vrac', 'Drafts')).toBeDefined();
  });

  it('ne remplace ni ne relit comme brouillon un message ordinaire', async () => {
    const inbox = (await find(sacha, 'Premier'))!;
    const replace = await sacha.request('POST', '/api/v1/messages/drafts', {
      subject: 'Tentative',
      html: 'x',
      replaces: inbox.id,
    });
    expect(replace.statusCode).toBe(400);
    expect(replace.json().error).toBe('not_a_draft');
    expect(await find(sacha, 'Premier')).toBeDefined();
    expect((await sacha.request('GET', `/api/v1/messages/${inbox.id}/draft`)).statusCode).toBe(404);
  });

  it('refuse de supprimer après envoi un message qui n’est pas un brouillon', async () => {
    const inbox = (await find(sacha, 'Troisième'))!;
    const sent = await sacha.request('POST', '/api/v1/messages/send', {
      to: [{ address: 'alice@exemple.com' }],
      subject: 'Envoi avec faux brouillon',
      html: 'x',
      draftId: inbox.id,
    });
    expect(sent.statusCode).toBe(200);
    expect(await find(sacha, 'Troisième')).toBeDefined();
  });
});

describe('préférences', () => {
  it('renvoie les valeurs par défaut puis enregistre une signature nettoyée', async () => {
    expect((await sacha.request('GET', '/api/v1/me/preferences')).json()).toMatchObject({
      theme: 'auto',
      accent: 'indigo',
      density: 'comfortable',
      signatureHtml: '',
    });
    const res = await sacha.request('PATCH', '/api/v1/me/preferences', {
      signatureHtml: '<p>Sacha <img src=x onerror=alert(1)><a href="javascript:x">x</a></p>',
      theme: 'dark',
      displayName: 'Sacha\r\nBcc: x@evil.example',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      theme: 'dark',
      signatureHtml: '<p>Sacha <a>x</a></p>',
      displayName: 'Sacha Bcc: x@evil.example',
    });
    // Les préférences d'un utilisateur ne sont pas visibles par un autre.
    expect((await alice.request('GET', '/api/v1/me/preferences')).json().theme).toBe('auto');
  });

  it.each([
    { theme: 'noir' },
    { accent: '#ff0000' },
    { notifications: { desktop: 'oui' } },
    { inconnu: 1 },
  ])('refuse %j', async (body) => {
    expect((await sacha.request('PATCH', '/api/v1/me/preferences', body)).statusCode).toBe(400);
  });
});

describe('libellés dans la barre latérale', () => {
  it('liste les libellés utilisés et filtre la liste par libellé', async () => {
    const msg = (await find(sacha, 'Troisième'))!;
    await sacha.request('PATCH', `/api/v1/messages/${msg.id}`, { labels: { add: ['Projet-X'] } });
    const labels = (await sacha.request('GET', '/api/v1/labels')).json().labels;
    expect(labels).toContain('Projet-X');
    const filtered = (await sacha.request('GET', '/api/v1/messages?label=Projet-X')).json();
    expect(filtered.messages.map((m: { subject: string }) => m.subject)).toEqual(['Troisième']);
    expect((await sacha.request('GET', '/api/v1/messages?label=avec%20espace')).statusCode).toBe(
      400,
    );
    expect((await alice.request('GET', '/api/v1/labels')).json().labels).not.toContain('Projet-X');
  });

  it('supprime un libellé de tous les messages, qui ne réapparaît plus', async () => {
    const first = (await find(sacha, 'Troisième'))!;
    await sacha.request('PATCH', `/api/v1/messages/${first.id}`, {
      labels: { add: ['A-supprimer', 'A-garder'] },
    });
    expect((await sacha.request('GET', '/api/v1/labels')).json().labels).toContain('A-supprimer');

    const res = await sacha.request('DELETE', '/api/v1/labels/A-supprimer');
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBeGreaterThanOrEqual(1);
    const labels = (await sacha.request('GET', '/api/v1/labels')).json().labels;
    // Encore déclaré par la boîte IMAP, mais plus porté par aucun message : absent de la liste.
    expect(labels).not.toContain('A-supprimer');
    expect(labels).toContain('A-garder');
    const detail = (await sacha.request('GET', `/api/v1/messages/${first.id}`)).json();
    expect(detail.keywords).not.toContain('A-supprimer');

    expect((await sacha.request('DELETE', '/api/v1/labels/avec%20espace')).statusCode).toBe(404);
    const noCsrf = await sacha.request('DELETE', '/api/v1/labels/A-garder', undefined, {
      'x-csrf-token': 'faux',
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('reporter', () => {
  it('reporte, liste le report, puis l’annule', async () => {
    await seedMailbox(gm, SACHA, [{ subject: 'Plus tard', text: 'x' }]);
    const msg = (await find(sacha, 'Plus tard'))!;
    const until = new Date(t.clock.now + 3 * 3_600_000).toISOString();
    const res = await sacha.request('POST', `/api/v1/messages/${msg.id}/snooze`, { until });
    expect(res.statusCode).toBe(200);
    const { snoozeId, wakeAt, from } = res.json();
    expect(wakeAt).toBe(until);
    expect(from).toBe('INBOX');
    expect(await find(sacha, 'Plus tard')).toBeUndefined();
    expect(await find(sacha, 'Plus tard', 'Reportés')).toBeDefined();

    const list = (await sacha.request('GET', '/api/v1/snoozes')).json().snoozes;
    expect(list).toHaveLength(1);
    expect((await alice.request('GET', '/api/v1/snoozes')).json().snoozes).toEqual([]);
    expect((await alice.request('DELETE', `/api/v1/snoozes/${snoozeId}`)).statusCode).toBe(404);

    expect((await sacha.request('DELETE', `/api/v1/snoozes/${snoozeId}`)).statusCode).toBe(204);
    expect(await find(sacha, 'Plus tard')).toBeDefined();
    expect((await sacha.request('GET', '/api/v1/snoozes')).json().snoozes).toEqual([]);
  });

  it.each([
    [{ until: 'demain' }],
    [{ until: new Date(Date.now() - 60_000).toISOString() }],
    [{ until: new Date(Date.now() + 2 * 366 * 24 * 3_600_000).toISOString() }],
    [{}],
  ])('refuse une échéance invalide (%j)', async (body) => {
    const msg = (await find(sacha, 'Premier'))!;
    const res = await sacha.request('POST', `/api/v1/messages/${msg.id}/snooze`, body);
    expect(res.statusCode).toBe(400);
  });
});

describe('photo de profil et langue', () => {
  it('réencode la photo en WebP sans métadonnées EXIF', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#3366cc' },
    })
      .jpeg()
      .withExifMerge({ IFD0: { Copyright: 'secret-exif', Artist: 'Sacha' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const put = await sacha.request('PUT', '/api/v1/me/avatar', { data: jpeg.toString('base64') });
    expect(put.statusCode).toBe(204);
    const get = await sacha.request('GET', '/api/v1/me/avatar');
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/webp');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    const body = get.rawPayload;
    const meta = await sharp(body).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual([
      'webp',
      256,
      256,
      undefined,
    ]);
    expect(body.includes(Buffer.from('secret-exif'))).toBe(false);
    expect((await sacha.request('GET', '/api/v1/me/preferences')).json().hasAvatar).toBe(true);
    // La photo d'un utilisateur n'est jamais servie à un autre.
    expect((await alice.request('GET', '/api/v1/me/avatar')).statusCode).toBe(404);
    expect((await sacha.request('DELETE', '/api/v1/me/avatar')).statusCode).toBe(204);
    expect((await sacha.request('GET', '/api/v1/me/avatar')).statusCode).toBe(404);
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>')],
    ['PNG tronqué', Buffer.from('89504e470d0a1a0a0000', 'hex')],
  ])('refuse une image invalide (%s)', async (_name, data) => {
    const res = await sacha.request('PUT', '/api/v1/me/avatar', { data: data.toString('base64') });
    expect(res.statusCode).toBe(422);
  });

  it('enregistre la langue et journalise les champs modifiés, sans leur valeur', async () => {
    const res = await sacha.request('PATCH', '/api/v1/me/preferences', {
      language: 'en',
      accent: 'teal',
    });
    expect(res.json()).toMatchObject({
      language: 'en',
      accent: 'teal',
      limits: expect.any(Object),
    });
    const { rows } = await infra.db.pool.query(
      "SELECT metadata FROM audit_log WHERE event = 'preferences_updated' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0].metadata).toEqual({ fields: ['accent', 'language'] });
    expect(
      (await sacha.request('PATCH', '/api/v1/me/preferences', { language: 'de' })).statusCode,
    ).toBe(400);
  });
});

describe('préférences : modifications simultanées', () => {
  it('aucune mise à jour n’est perdue', async () => {
    await sacha.request('PATCH', '/api/v1/me/preferences', {
      theme: 'auto',
      language: 'fr',
      notifications: { desktop: false, sound: false, dailyDigest: false },
    });
    const results = await Promise.all([
      sacha.request('PATCH', '/api/v1/me/preferences', { language: 'en' }),
      sacha.request('PATCH', '/api/v1/me/preferences', { theme: 'dark' }),
      sacha.request('PATCH', '/api/v1/me/preferences', { accent: 'rose' }),
      sacha.request('PATCH', '/api/v1/me/preferences', { notifications: { sound: true } }),
      sacha.request('PATCH', '/api/v1/me/preferences', { notifications: { dailyDigest: true } }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect((await sacha.request('GET', '/api/v1/me/preferences')).json()).toMatchObject({
      language: 'en',
      theme: 'dark',
      accent: 'rose',
      notifications: { desktop: false, sound: true, dailyDigest: true },
    });
  });
});
