import type { AddressInfo } from 'node:net';
import {
  BODY_HEIGHT_SCRIPT_HASH,
  loginFor,
  SafeFetchError,
  serverFor,
  verifyImapLogin,
} from '@plume/mail';
import { seedMailbox, startGreenMail, type StartedGreenMail } from '@plume/testing';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeMessageId, encodeAttachmentId } from '../src/lib/ids.js';
import {
  client,
  createTestApp,
  login,
  ORIGIN,
  resetInfra,
  SESSION_COOKIE,
  startInfra,
  testConfig,
  type Client,
  type Infra,
  type TestApp,
} from './support/harness.js';

const SACHA = { email: 'sacha@exemple.com', password: 'imap-sacha' };
const ALICE = { email: 'alice@exemple.com', password: 'imap-alice' };
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3d1a1e30000000049454e44ae426082',
  'hex',
);

let infra: Infra;
let gm: StartedGreenMail;
let t: TestApp;
let sacha: Client;
let alice: Client;
const fetchImage = vi.fn(async (url: string) => {
  if (url.includes('169.254')) throw new SafeFetchError('forbidden_address');
  return { contentType: 'image/png', body: PNG };
});

beforeAll(async () => {
  [infra, gm] = await Promise.all([startInfra(), startGreenMail([SACHA, ALICE])]);
  await resetInfra(infra);
  await seedMailbox(gm, SACHA, [
    ...Array.from({ length: 12 }, (_, i) => ({ subject: `Note ${i + 1}`, text: `texte ${i + 1}` })),
    {
      subject: 'Facture <script>window.__xss=1</script>',
      from: '"<img src=x onerror=window.__xss=1>" <factures@nimbus.example>',
      html:
        '<p>Bonjour</p><img src="cid:logo@nimbus"><img src="https://tracker.example/p.gif">' +
        '<script>window.__xss=1</script><a href="javascript:window.__xss=1">x</a>',
      attachments: [
        {
          filename: 'facture.pdf',
          content: Buffer.from('%PDF-1.4 facture'),
          contentType: 'application/pdf',
        },
        { filename: 'logo.png', content: PNG, contentType: 'image/png', cid: 'logo@nimbus' },
        { filename: '../../etc/passwd', content: 'root:x:0:0', contentType: 'text/plain' },
        { filename: 'rapport.pdf.exe', content: 'MZ', contentType: 'application/pdf' },
        {
          filename: 'image.png',
          content: '<html><script>window.__xss=1</script>',
          contentType: 'image/png',
        },
      ],
      flags: ['\\Flagged'],
    },
  ]);
  await seedMailbox(gm, ALICE, [{ subject: 'Secret d’Alice', text: 'confidentiel alice' }]);

  const config = testConfig((raw) => {
    raw.domains[0].imap = { host: gm.host, port: gm.imapsPort, security: 'tls' };
    raw.domains[0].tls = { reject_unauthorized: false };
  });
  t = await createTestApp(infra, {
    config,
    verifyLogin: (domain, email, password) =>
      verifyImapLogin(serverFor(domain, 'imap'), loginFor(domain, email), password),
    fetchImage,
  });
  sacha = client(t.app);
  alice = client(t.app);
  expect((await login(sacha, SACHA.email, SACHA.password)).statusCode).toBe(200);
  expect((await login(alice, ALICE.email, ALICE.password)).statusCode).toBe(200);
});

afterAll(async () => {
  await t?.app.close();
  await Promise.all([infra?.stop(), gm?.stop()]);
});

async function invoice(c: Client = sacha) {
  const res = await c.request('GET', '/api/v1/messages?filter=flagged');
  return res.json().messages[0] as { id: string; subject: string };
}

describe('dossiers et liste', () => {
  it('exige une session', async () => {
    expect((await client(t.app).request('GET', '/api/v1/folders')).statusCode).toBe(401);
    expect((await client(t.app).request('GET', '/api/v1/messages')).statusCode).toBe(401);
  });

  it('liste les dossiers', async () => {
    const res = await sacha.request('GET', '/api/v1/folders');
    expect(res.statusCode).toBe(200);
    expect(res.json().folders[0]).toMatchObject({
      path: 'INBOX',
      specialUse: '\\Inbox',
      total: 13,
    });
  });

  it('pagine avec un curseur opaque', async () => {
    const page1 = (await sacha.request('GET', '/api/v1/messages?limit=5')).json();
    expect(page1.messages).toHaveLength(5);
    expect(page1.total).toBe(13);
    const page2 = (
      await sacha.request('GET', `/api/v1/messages?limit=5&cursor=${page1.nextCursor}`)
    ).json();
    expect(page2.messages[0].id).not.toBe(page1.messages[0].id);
    const bad = await sacha.request('GET', '/api/v1/messages?cursor=nimporte-quoi');
    expect(bad.statusCode).toBe(400);
  });

  it('rejette les paramètres invalides', async () => {
    for (const query of ['filter=tout', 'limit=1000', 'extra=1', `q=${'x'.repeat(300)}`]) {
      expect((await sacha.request('GET', `/api/v1/messages?${query}`)).statusCode).toBe(400);
    }
    expect((await sacha.request('GET', '/api/v1/messages?folder=Inexistant')).statusCode).toBe(404);
  });

  it('renvoie les données de l’expéditeur telles quelles (échappement côté interface)', async () => {
    const message = await invoice();
    expect(message.subject).toBe('Facture <script>window.__xss=1</script>');
  });
});

describe('message', () => {
  it('renvoie le détail et marque comme lu', async () => {
    const { id } = await invoice();
    const res = await sacha.request('GET', `/api/v1/messages/${id}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.seen).toBe(true);
    expect(detail.attachments.map((a: { filename: string }) => a.filename).sort()).toEqual(
      ['../../etc/passwd', 'facture.pdf', 'image.png', 'logo.png', 'rapport.pdf.exe'].sort(),
    );
    expect(detail.remoteImagesPolicy).toBe('block_by_default');
    expect(detail.blockedRemoteImages).toBe(1);
  });

  it.each(['x', 'AAAA', 'W10', Buffer.from('["INBOX","1",-1]').toString('base64url')])(
    'rejette un identifiant invalide (%s)',
    async (id) => {
      expect((await sacha.request('GET', `/api/v1/messages/${id}`)).statusCode).toBe(404);
    },
  );
});

describe('contrôle d’accès (IDOR)', () => {
  it('un identifiant d’un autre utilisateur ne donne jamais accès à ses données', async () => {
    const { id } = await invoice(sacha);
    for (const path of [`/api/v1/messages/${id}`, `/api/v1/messages/${id}/body`]) {
      const res = await alice.request('GET', path);
      expect(res.body).not.toContain('Facture');
      expect(res.body).not.toContain('Bonjour');
    }
    const attachments = (await sacha.request('GET', `/api/v1/messages/${id}`)).json().attachments;
    for (const attachment of attachments) {
      const res = await alice.request('GET', `/api/v1/attachments/${attachment.id}`);
      expect(res.body).not.toContain('%PDF');
      expect(res.statusCode).not.toBe(200);
    }
    const aliceList = (await alice.request('GET', '/api/v1/messages')).json();
    expect(aliceList.messages.map((m: { subject: string }) => m.subject)).toEqual([
      'Secret d’Alice',
    ]);
  });

  it('une URL signée pour un utilisateur ne vaut pas pour un autre', async () => {
    const { id } = await invoice();
    const body = (await sacha.request('GET', `/api/v1/messages/${id}/body`)).body;
    const src = new JSDOM(body).window.document.querySelector('img')?.getAttribute('src') as string;
    const url = new URL(src, ORIGIN);
    const aliceId = (await alice.request('GET', '/api/v1/users/me')).statusCode; // route inexistante
    expect(aliceId).toBe(404);
    const aliceUser = (await alice.request('GET', '/api/v1/me')).json().id as string;
    url.searchParams.set('u', aliceUser);
    const res = await t.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(res.statusCode).toBe(403);
  });
});

describe('citation', () => {
  it('renvoie le texte du mail sans le script de mesure ni les styles', async () => {
    const { id } = await invoice();
    const res = await sacha.request('GET', `/api/v1/messages/${id}/quote`);
    expect(res.statusCode).toBe(200);
    const { text } = res.json() as { text: string };
    expect(text).toContain('Bonjour');
    expect(text).not.toContain('plume:body-height');
    expect(text).not.toContain('ResizeObserver');
    expect(text).not.toMatch(/[{}]/);
  });
});

describe('corps isolé', () => {
  it('est servi avec une CSP stricte et un bac à sable', async () => {
    const { id } = await invoice();
    const res = await sacha.request('GET', `/api/v1/messages/${id}/body`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(csp).not.toContain('allow-same-origin');
    // Seul le script de mesure de hauteur, par son empreinte ; jamais de script en ligne libre.
    expect(csp).toContain(`script-src ${BODY_HEIGHT_SCRIPT_HASH}`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-plume-blocked-images']).toBe('1');
    const doc = new JSDOM(res.body).window.document;
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('body script')).toBeNull();
    expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(res.body).not.toContain('tracker.example');
  });

  it('suit le thème demandé, et refuse une valeur inconnue', async () => {
    const { id } = await invoice();
    const light = await sacha.request('GET', `/api/v1/messages/${id}/body?theme=light`);
    expect(light.body).toContain('color-scheme:light');
    const dark = await sacha.request('GET', `/api/v1/messages/${id}/body?theme=dark`);
    expect(dark.statusCode).toBe(200);
    // Le mail de test impose ses couleurs ou non : dans les deux cas, un seul schéma de couleurs.
    expect(dark.body).toMatch(/color-scheme:(dark|light)/);
    expect((await sacha.request('GET', `/api/v1/messages/${id}/body?theme=sepia`)).statusCode).toBe(
      400,
    );
  });

  it('charge les images distantes via le proxy signé quand on le demande', async () => {
    const { id } = await invoice();
    const res = await sacha.request('GET', `/api/v1/messages/${id}/body?images=1`);
    expect(res.headers['x-plume-blocked-images']).toBe('0');
    const imgs = [...new JSDOM(res.body).window.document.querySelectorAll('img')].map(
      (img) => img.getAttribute('src') as string,
    );
    const proxied = imgs.find((src) => src.startsWith('/api/v1/image-proxy'));
    expect(proxied).toContain(encodeURIComponent('https://tracker.example/p.gif'));

    // Le proxy fonctionne sans cookie (iframe d'origine opaque) grâce à la signature.
    const proxy = await t.app.inject({ method: 'GET', url: proxied as string });
    expect(proxy.statusCode).toBe(200);
    expect(proxy.headers['content-type']).toBe('image/png');
    expect(proxy.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(proxy.headers['x-content-type-options']).toBe('nosniff');
    expect(proxy.headers['set-cookie']).toBeUndefined();
    expect(fetchImage).toHaveBeenCalledWith('https://tracker.example/p.gif');
  });

  it('résout les images intégrées par une URL signée', async () => {
    const { id } = await invoice();
    const res = await sacha.request('GET', `/api/v1/messages/${id}/body`);
    const src = new JSDOM(res.body).window.document
      .querySelector('img')
      ?.getAttribute('src') as string;
    expect(src).toMatch(
      /^\/api\/v1\/attachments\/[\w-]+\?inline=1&u=[\w-]+&exp=\d+&sig=[\w-]{43}$/,
    );
    const image = await t.app.inject({ method: 'GET', url: src });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');

    const tampered = src.replace(/sig=[\w-]{5}/, 'sig=AAAAA');
    expect((await t.app.inject({ method: 'GET', url: tampered })).statusCode).toBe(403);
    t.clock.now += 2 * 3_600_000;
    expect((await t.app.inject({ method: 'GET', url: src })).statusCode).toBe(403);
    t.clock.now -= 2 * 3_600_000;
    // Une URL signée ne permet jamais le téléchargement complet.
    const download = src.replace('inline=1&', '');
    expect((await t.app.inject({ method: 'GET', url: download })).statusCode).toBe(403);
  });
});

describe('proxy d’images', () => {
  it('exige une signature valide', async () => {
    const url = encodeURIComponent('https://images.example/a.png');
    for (const query of [`url=${url}`, `url=${url}&exp=9999999999999&sig=${'A'.repeat(43)}`]) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/image-proxy?${query}` });
      expect([400, 403]).toContain(res.statusCode);
    }
  });

  it('refuse les adresses internes', async () => {
    const target = 'http://169.254.169.254/latest/meta-data/';
    const exp = t.clock.now + 60_000;
    const sig = t.services.signer.sign('image-proxy', [target], exp);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/image-proxy?url=${encodeURIComponent(target)}&exp=${exp}&sig=${sig}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'image_unavailable' });
  });
});

describe('pièces jointes', () => {
  async function attachments() {
    const { id } = await invoice();
    const detail = (await sacha.request('GET', `/api/v1/messages/${id}`)).json();
    return Object.fromEntries(
      detail.attachments.map((a: { filename: string; id: string }) => [a.filename, a.id]),
    ) as Record<string, string>;
  }

  it('télécharge avec un nom nettoyé et un type neutre', async () => {
    const ids = await attachments();
    const res = await sacha.request('GET', `/api/v1/attachments/${ids['../../etc/passwd']}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="passwd"; filename*=UTF-8\'\'passwd',
    );
    const exe = await sacha.request('GET', `/api/v1/attachments/${ids['rapport.pdf.exe']}`);
    expect(exe.headers['content-disposition']).toContain('filename="rapport.pdf.exe"');
    expect(exe.headers['content-type']).toBe('application/octet-stream');
  });

  it('prévisualise un PDF réel, mais pas un faux PNG contenant du HTML', async () => {
    const ids = await attachments();
    const pdf = await sacha.request('GET', `/api/v1/attachments/${ids['facture.pdf']}?inline=1`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^inline;/);
    const fake = await sacha.request('GET', `/api/v1/attachments/${ids['image.png']}?inline=1`);
    expect(fake.statusCode).toBe(415);
    const png = await sacha.request('GET', `/api/v1/attachments/${ids['logo.png']}?inline=1`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-security-policy']).toContain('sandbox');
  });

  it('refuse une partie inexistante ou un identifiant forgé', async () => {
    const { id } = await invoice();
    const ref = decodeMessageId(id)!;
    expect(
      (await sacha.request('GET', `/api/v1/attachments/${encodeAttachmentId(ref, '42')}`))
        .statusCode,
    ).toBe(404);
    const forged = Buffer.from(
      JSON.stringify(['INBOX', ref.uidValidity, ref.uid, '1;rm -rf']),
    ).toString('base64url');
    expect((await sacha.request('GET', `/api/v1/attachments/${forged}`)).statusCode).toBe(404);
  });

  it('exige une session pour le téléchargement', async () => {
    const ids = await attachments();
    expect(
      (await client(t.app).request('GET', `/api/v1/attachments/${ids['facture.pdf']}`)).statusCode,
    ).toBe(401);
  });
});

describe('événements temps réel (SSE)', () => {
  it('signale l’arrivée d’un nouveau message', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      headers: { cookie: `${SESSION_COOKIE}=${sacha.cookie}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const waitFor = async (needle: string) => {
      const deadline = Date.now() + 20_000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      return buffer.includes(needle);
    };
    expect(await waitFor('event: ready')).toBe(true);
    await seedMailbox(gm, SACHA, [{ subject: 'Nouveau', text: 'arrivé' }]);
    expect(await waitFor('event: mailbox')).toBe(true);
    controller.abort();

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/v1/events`);
    expect(anonymous.status).toBe(401);
  });
});
