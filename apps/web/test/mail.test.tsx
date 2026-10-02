import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api/client';
import { I18nProvider } from '../src/i18n';
import { createAppRouter, validateMailSearch } from '../src/router';

const XSS = '<img src=x onerror="window.__xss=1">';
const message = {
  id: 'bWVzc2FnZS0x',
  folder: 'INBOX',
  subject: `Facture ${XSS}`,
  from: [{ name: XSS, address: 'factures@nimbus.example' }],
  to: [{ name: '', address: 'sacha@exemple.com' }],
  date: '2026-09-20T08:00:00.000Z',
  size: 1000,
  seen: false,
  flagged: true,
  answered: false,
  keywords: ['<b>Factures</b>'],
  hasAttachments: true,
};

const detail = {
  ...message,
  seen: true,
  cc: [],
  replyTo: [],
  messageId: null,
  attachments: [
    {
      id: 'YXR0LTE',
      filename: `${XSS}.pdf`,
      contentType: 'application/pdf',
      size: 2048,
      inline: false,
      previewable: true,
    },
  ],
  remoteImagesPolicy: 'block_by_default',
  blockedRemoteImages: 2,
};

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

const calls: { url: string; method: string; body: unknown }[] = [];
let detailOverride: Record<string, unknown> = {};

beforeEach(() => {
  setCsrfToken(null);
  calls.length = 0;
  detailOverride = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith('/messages/drafts')) return json(200, { id: 'YnJvdWlsbG9u' });
      if (url.endsWith('/draft')) return json(200, { html: '<p>Corps du brouillon</p>' });
      if (url.endsWith('/junk')) return json(200, { id: 'c3BhbQ', folder: 'Junk', from: 'INBOX' });
      if (url.endsWith('/archive'))
        return json(200, { id: 'YXJjaGl2ZWQ', folder: 'Archives', from: 'INBOX' });
      if (url.endsWith('/move'))
        return json(200, { id: 'bWVzc2FnZS0x', folder: 'INBOX', from: 'Archives' });
      if (url.endsWith('/quote')) return json(200, { text: 'Ligne <script>1</script>' });
      if (url.endsWith('/labels')) return json(200, { labels: ['Factures', '<b>x</b>'] });
      if (url.includes('/labels/') && init.method === 'DELETE') return json(200, { removed: 1 });
      if (url.endsWith('/snooze')) {
        return json(200, {
          id: 'cmVwb3J0ZQ',
          snoozeId: '11111111-1111-4111-8111-111111111111',
          from: 'INBOX',
          wakeAt: '2030-01-01T08:00:00.000Z',
        });
      }
      if (url.includes('/snoozes/') && init.method === 'DELETE') return json(204);
      if (url.endsWith('/snoozes')) return json(200, { snoozes: [] });
      if (url.endsWith('/messages/send')) return json(200, { status: 'sent' });
      if (url.endsWith('/me/preferences')) {
        return json(200, {
          theme: 'auto',
          accent: 'indigo',
          density: 'comfortable',
          language: 'fr',
          notifications: {},
          signatureHtml: '<p>Sacha</p>',
          displayName: null,
          limits: { maxAttachmentSize: 10, maxUploadTotal: 15 },
        });
      }
      if (url.endsWith('/auth/session')) {
        return json(200, { status: 'ok', csrfToken: 'c', user: { email: 'sacha@exemple.com' } });
      }
      if (url.startsWith('/api/v1/folders')) {
        return json(200, {
          folders: [
            {
              path: 'INBOX',
              name: 'INBOX',
              delimiter: '/',
              specialUse: '\\Inbox',
              total: 1,
              unseen: 1,
            },
            {
              path: 'Archives',
              name: 'Archives',
              delimiter: '/',
              specialUse: '\\Archive',
              total: 3,
              unseen: 0,
            },
            {
              path: 'Junk',
              name: 'Junk',
              delimiter: '/',
              specialUse: '\\Junk',
              total: 0,
              unseen: 0,
            },
            {
              path: 'Projets <x>',
              name: 'Projets <x>',
              delimiter: '/',
              specialUse: null,
              total: 0,
              unseen: 0,
            },
          ],
        });
      }
      if (url.startsWith('/api/v1/messages?'))
        return json(200, { messages: [message], nextCursor: null, total: 1 });
      if (url.startsWith('/api/v1/messages/')) return json(200, { ...detail, ...detailOverride });
      return json(404, { error: 'not_found' });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient);
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) } as never);
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return router;
}

describe('messagerie', () => {
  it('affiche les données de l’expéditeur comme du texte', async () => {
    renderApp('/');
    expect(await screen.findByText(`Facture ${XSS}`)).toBeTruthy();
    expect(screen.getByText(XSS)).toBeTruthy();
    expect(screen.getByText('<b>Factures</b>')).toBeTruthy();
    expect(screen.getByText('Projets <x>')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('ouvre le message dans une iframe isolée, sans même origine', async () => {
    const user = userEvent.setup();
    const router = renderApp('/');
    await user.click(await screen.findByText(`Facture ${XSS}`));
    const frame = (await screen.findByTitle('Contenu du message')) as HTMLIFrameElement;
    const sandbox = frame.getAttribute('sandbox') ?? '';
    // Script de mesure de hauteur seulement (CSP du document) ; origine opaque.
    expect(sandbox).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(frame.getAttribute('src')).toBe('/api/v1/messages/bWVzc2FnZS0x/body?theme=light');
    expect(router.state.location.search).toMatchObject({ m: 'bWVzc2FnZS0x' });

    // Hauteur transmise par le document du mail : acceptée seulement depuis cette iframe.
    const post = (data: unknown, source: MessageEventSource | null) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, source }));
      });
    post({ type: 'plume:body-height', height: 1234 }, window);
    expect(frame.style.height).toBe('');
    post({ type: 'plume:body-height', height: 'x' }, frame.contentWindow);
    expect(frame.style.height).toBe('');
    post({ type: 'plume:body-height', height: 1234.2 }, frame.contentWindow);
    expect(frame.style.height).toBe('1235px');
    post({ type: 'plume:body-height', height: 1e9 }, frame.contentWindow);
    expect(frame.style.height).toBe('200000px');

    expect(screen.getByText(/2 image\(s\) distante\(s\) bloquée\(s\)/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Afficher les images' }));
    await waitFor(() =>
      expect(
        (screen.getByTitle('Contenu du message') as HTMLIFrameElement).getAttribute('src'),
      ).toBe('/api/v1/messages/bWVzc2FnZS0x/body?theme=light&images=1'),
    );

    const download = screen.getByRole('link', { name: /^Télécharger / });
    expect(download.getAttribute('href')).toBe('/api/v1/attachments/YXR0LTE');
    await user.click(screen.getByRole('button', { name: 'Aperçu' }));
    const viewer = (await screen.findByTitle(`Aperçu de ${XSS}.pdf`)) as HTMLIFrameElement;
    // Visionneuse PDF isolée : scripts autorisés, mais origine opaque (pas allow-same-origin).
    expect(viewer.getAttribute('sandbox')).toBe('allow-scripts');
    expect(viewer.getAttribute('src')).toBe('/viewer/pdf.html');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});

describe('actions', () => {
  it('archive avec possibilité d’annuler', async () => {
    const user = userEvent.setup();
    renderApp('/?m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Archiver' }));
    expect(await screen.findByText('Message archivé.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/YXJjaGl2ZWQ/move'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/move'))?.body).toEqual({ folder: 'INBOX' });
  });

  it('répond avec citation échappée, signature et en-tête de fil', async () => {
    const user = userEvent.setup();
    renderApp('/?m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Répondre' }));
    const dialog = await screen.findByRole('dialog');
    expect((screen.getByLabelText('Objet') as HTMLInputElement).value).toBe(`Re: Facture ${XSS}`);
    expect((screen.getByLabelText('À') as HTMLInputElement).value).toBe(
      `${XSS} <factures@nimbus.example>`,
    );
    const body = screen.getByRole('textbox', { name: 'Corps du message' });
    await waitFor(() => expect(body.innerHTML).toContain('&lt;script&gt;1&lt;/script&gt;'));
    expect(body.querySelector('script')).toBeNull();
    expect(body.innerHTML).toContain('<p>Sacha</p>');
    await user.click(within(dialog).getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/messages/send'))?.body as Record<
      string,
      unknown
    >;
    expect(sent.inReplyTo).toBe('bWVzc2FnZS0x');
    expect(sent.to).toEqual([{ name: XSS, address: 'factures@nimbus.example' }]);
    expect(dialog.isConnected).toBe(false);
  });

  it('dans les archives, propose de remettre en boîte de réception au lieu d’archiver', async () => {
    detailOverride = { folder: 'Archives' };
    const user = userEvent.setup();
    renderApp('/?folder=Archives&m=bWVzc2FnZS0x');
    await user.click(
      await screen.findByRole('button', { name: 'Remettre dans la boîte de réception' }),
    );
    expect(screen.queryByRole('button', { name: 'Archiver' })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/move'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/move'))?.body).toEqual({ folder: 'INBOX' });
  });

  it('signale comme indésirable, avec possibilité d’annuler', async () => {
    const user = userEvent.setup();
    renderApp('/?m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Signaler comme indésirable' }));
    expect(await screen.findByText('Message déplacé dans les indésirables.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/bWVzc2FnZS0x/junk'))).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/c3BhbQ/move'))).toBe(true));
  });

  it('dans les indésirables, propose « Pas un indésirable » (retour en boîte de réception)', async () => {
    detailOverride = { folder: 'Junk' };
    const user = userEvent.setup();
    renderApp('/?folder=Junk&m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: /^Pas un indésirable/ }));
    expect(screen.queryByRole('button', { name: 'Signaler comme indésirable' })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/move'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/move'))?.body).toEqual({ folder: 'INBOX' });
  });

  it('refuse un libellé invalide sans appeler le serveur', async () => {
    const user = userEvent.setup();
    renderApp('/?m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Libellés' }));
    const input = await screen.findByPlaceholderText('Ajouter un libellé');
    await user.type(input, 'avec espace{Enter}');
    expect(await screen.findByText(/Libellé invalide/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('libellés et reports', () => {
  it('affiche les libellés dans la barre latérale, comme du texte', async () => {
    renderApp('/');
    const link = await screen.findByRole('link', { name: '<b>x</b>' });
    expect(link.getAttribute('href')).toContain('label=');
    expect(screen.getByRole('link', { name: 'Factures' }).getAttribute('href')).toContain(
      'label=Factures',
    );
  });

  it('reporte à demain matin, avec possibilité d’annuler', async () => {
    const user = userEvent.setup();
    renderApp('/?m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Reporter le message' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Demain, 8 h' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/snooze'))).toBe(true));
    const until = new Date(
      (calls.find((c) => c.url.endsWith('/snooze'))?.body as { until: string }).until,
    );
    expect(until.getHours()).toBe(8);
    expect(until.getTime()).toBeGreaterThan(Date.now());
    await user.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/snoozes/'))).toBe(true),
    );
  });
});

describe('suppression d’un libellé', () => {
  it('demande confirmation puis supprime le libellé', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Supprimer le libellé Factures' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/labels/Factures'))).toBe(
        true,
      ),
    );
  });

  it('ne supprime rien si l’utilisateur annule', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Supprimer le libellé Factures' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('glisser-déposer et réponse rapide', () => {
  /** DataTransfer minimal (jsdom n'en fournit pas). */
  function dataTransfer() {
    const store = new Map<string, string>();
    return {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      get types() {
        return [...store.keys()];
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    };
  }

  it('déplace un message déposé sur un dossier, en le retirant aussitôt de la liste', async () => {
    renderApp('/');
    const row = (await screen.findByText(`Facture ${XSS}`)).closest('button')!;
    const transfer = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: transfer });
    const target = screen.getByRole('link', { name: 'Projets <x>' });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    expect(target.hasAttribute('data-drop-target')).toBe(true);
    fireEvent.drop(target, { dataTransfer: transfer });
    // Mise à jour optimiste : la ligne disparaît avant la réponse du serveur.
    await waitFor(() => expect(screen.queryByText(`Facture ${XSS}`)).toBeNull());
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/move'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/move'))?.body).toEqual({ folder: 'Projets <x>' });
  });

  it('le message ouvert se glisse par son titre vers un dossier', async () => {
    renderApp('/?m=bWVzc2FnZS0x');
    const title = await screen.findByRole('heading', { level: 2, name: `Facture ${XSS}` });
    expect(title.getAttribute('draggable')).toBe('true');
    const transfer = dataTransfer();
    fireEvent.dragStart(title, { dataTransfer: transfer });
    const target = screen.getByRole('link', { name: 'Projets <x>' });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/move'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/move'))?.body).toEqual({ folder: 'Projets <x>' });
  });

  it('ignore un dépôt qui ne vient pas de la liste', async () => {
    renderApp('/');
    await screen.findByText(`Facture ${XSS}`);
    const target = screen.getByRole('link', { name: 'Projets <x>' });
    const transfer = dataTransfer();
    transfer.setData('text/plain', 'bonjour');
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(calls.some((c) => c.url.endsWith('/move'))).toBe(false);
  });

  it('pas de barre de réponse rapide ; « Répondre » ouvre la rédaction avec la signature', async () => {
    const user = userEvent.setup();
    renderApp('/?m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Répondre' }));
    expect(screen.queryByLabelText('Réponse rapide')).toBeNull();
    const dialog = await screen.findByRole('dialog');
    const body = within(dialog).getByRole('textbox', { name: 'Corps du message' });
    body.insertAdjacentHTML('afterbegin', '<p>Merci</p>');
    fireEvent.input(body);
    await user.click(within(dialog).getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/messages/send'))?.body as { html: string };
    expect(sent.html).toContain('Merci');
    expect(sent.html).toContain('<p>Sacha</p>');
  });
});

describe('composeur', () => {
  it('fermeture sans modification : aucune question', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Nouveau message' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Fermer la fenêtre de rédaction' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fermeture d’un message modifié : propose de l’enregistrer dans les brouillons', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Nouveau message' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('À'), 'alice@exemple.com, pas-une-adresse');
    await user.type(within(dialog).getByLabelText('Objet'), 'Idée');
    await user.click(
      within(dialog).getByRole('button', { name: 'Fermer la fenêtre de rédaction' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Enregistrer ce message dans les brouillons ?',
    });
    // « Continuer la rédaction » : la fenêtre reste ouverte, rien n'est envoyé.
    await user.click(within(confirm).getByRole('button', { name: 'Continuer la rédaction' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.click(
      within(dialog).getByRole('button', { name: 'Fermer la fenêtre de rédaction' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Enregistrer le brouillon',
      }),
    );
    expect(await screen.findByText('Brouillon enregistré.')).toBeTruthy();
    const saved = calls.find((c) => c.url.endsWith('/messages/drafts'))?.body as Record<
      string,
      unknown
    >;
    // Une adresse encore incomplète n'empêche pas d'enregistrer le brouillon.
    expect(saved.to).toEqual([{ name: '', address: 'alice@exemple.com' }]);
    expect(saved.subject).toBe('Idée');
    expect(saved.replaces).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('« Supprimer » ferme sans rien enregistrer', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Nouveau message' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Objet'), 'À jeter');
    await user.click(
      within(dialog).getByRole('button', { name: 'Fermer la fenêtre de rédaction' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/messages/drafts'))).toBe(false);
  });

  it('reprend un brouillon, puis l’envoie (le brouillon est désigné pour suppression)', async () => {
    detailOverride = {
      folder: 'Drafts',
      draft: true,
      to: [{ name: 'Alice', address: 'alice@exemple.com' }],
      bcc: [{ name: '', address: 'cache@exemple.org' }],
      subject: 'Brouillon en cours',
      attachments: [],
    };
    const user = userEvent.setup();
    renderApp('/?folder=Drafts&m=bWVzc2FnZS0x');
    await user.click(await screen.findByRole('button', { name: 'Reprendre le brouillon' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Objet') as HTMLInputElement).value).toBe(
      'Brouillon en cours',
    );
    expect((within(dialog).getByLabelText('Cci') as HTMLInputElement).value).toBe(
      'cache@exemple.org',
    );
    const body = within(dialog).getByRole('textbox', { name: 'Corps du message' });
    await waitFor(() => expect(body.innerHTML).toContain('Corps du brouillon'));
    // Signature non ajoutée une seconde fois.
    expect(body.innerHTML).not.toContain('<p>Sacha</p>');
    await user.click(within(dialog).getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/messages/send'))?.body as Record<
      string,
      unknown
    >;
    expect(sent.draftId).toBe('bWVzc2FnZS0x');
    expect(sent.bcc).toEqual([{ name: '', address: 'cache@exemple.org' }]);
  });

  it('refuse d’emblée une pièce jointe trop volumineuse', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'Nouveau message' }));
    const input = (await screen.findByLabelText('Joindre des fichiers')) as HTMLInputElement;
    await user.upload(input, new File(['x'.repeat(11)], 'gros.bin'));
    expect(await screen.findByText(/« gros.bin » dépasse la taille maximale/)).toBeTruthy();
    await user.upload(input, new File(['x'.repeat(5)], 'petit.txt'));
    expect(await screen.findByText('petit.txt')).toBeTruthy();
  });
});

describe('validateMailSearch', () => {
  it('ignore les valeurs inattendues', () => {
    expect(validateMailSearch({ folder: '', filter: 'tout', q: 42, m: '<script>' })).toEqual({});
    expect(
      validateMailSearch({ folder: 'INBOX', filter: 'unseen', q: 'x'.repeat(300), m: 'abc_-' }),
    ).toEqual({
      folder: 'INBOX',
      filter: 'unseen',
      q: 'x'.repeat(200),
      m: 'abc_-',
    });
  });
});
