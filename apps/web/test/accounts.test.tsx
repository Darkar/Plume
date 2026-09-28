import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api/client';
import { I18nProvider } from '../src/i18n';
import { createAppRouter } from '../src/router';

vi.mock('../src/lib/reload', () => ({ reloadApp: vi.fn() }));
const { reloadApp } = await import('../src/lib/reload');

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

const calls: { url: string; method: string; body: unknown }[] = [];
let addResult: { status: number; body: unknown } = { status: 200, body: {} };

const session = {
  status: 'ok',
  csrfToken: 'c',
  user: { email: 'sacha@exemple.com' },
  accounts: [
    { email: 'sacha@exemple.com', active: true },
    { email: 'alice@exemple.com', active: false },
  ],
};

beforeEach(() => {
  setCsrfToken(null);
  calls.length = 0;
  vi.mocked(reloadApp).mockClear();
  addResult = { status: 200, body: { ...session, status: 'ok' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method: init.method ?? 'GET', body });
      if (url.endsWith('/auth/session')) return json(200, session);
      if (url.endsWith('/auth/switch')) return json(200, session);
      if (url.endsWith('/auth/accounts/remove')) return json(200, session);
      if (url.endsWith('/auth/accounts/totp')) return json(200, session);
      if (url.endsWith('/auth/accounts')) return json(addResult.status, addResult.body);
      if (url.endsWith('/me/preferences')) {
        return json(200, {
          theme: 'auto',
          accent: 'indigo',
          density: 'comfortable',
          language: 'fr',
          notifications: {},
          signatureHtml: '',
          displayName: null,
          limits: { maxAttachmentSize: 10, maxUploadTotal: 15 },
        });
      }
      if (url.startsWith('/api/v1/folders')) return json(200, { folders: [] });
      if (url.endsWith('/labels')) return json(200, { labels: [] });
      if (url.startsWith('/api/v1/messages')) {
        return json(200, { messages: [], nextCursor: null, total: 0 });
      }
      return json(404, { error: 'not_found' });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient);
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) } as never);
  render(
    <I18nProvider locale="fr">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return router;
}

describe('plusieurs comptes', () => {
  it('bascule vers un autre compte depuis la carte de compte', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: /Compte : sacha@exemple\.com/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Passer à alice@exemple.com' }));
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith('/auth/switch'))?.body).toEqual({
      email: 'alice@exemple.com',
    });
  });

  it('ferme le compte actif', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: /Compte : sacha@exemple\.com/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Fermer sacha@exemple.com' }));
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith('/auth/accounts/remove'))?.body).toEqual({
      email: 'sacha@exemple.com',
    });
  });

  it('ajoute un compte protégé par un second facteur', async () => {
    addResult = {
      status: 200,
      body: { ...session, status: 'totp_required', pendingAccount: 'bob@exemple.com' },
    };
    const user = userEvent.setup();
    renderAt('/comptes/ajouter');
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'bob@exemple.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Ajouter le compte' }));
    await user.type(await screen.findByLabelText('Code de vérification'), '123456');
    await user.click(screen.getByRole('button', { name: 'Vérifier' }));
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith('/auth/accounts'))?.body).toEqual({
      email: 'bob@exemple.com',
      password: 'secret',
    });
    expect(calls.find((c) => c.url.endsWith('/auth/accounts/totp'))?.body).toEqual({
      code: '123456',
    });
  });

  it('affiche un refus sans basculer', async () => {
    addResult = { status: 409, body: { error: 'account_already_open' } };
    const user = userEvent.setup();
    renderAt('/comptes/ajouter');
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'alice@exemple.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Ajouter le compte' }));
    expect(await screen.findByText('Ce compte est déjà ouvert.')).toBeTruthy();
    expect(reloadApp).not.toHaveBeenCalled();
  });
});
