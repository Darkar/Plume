import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api/client';
import { I18nProvider } from '../src/i18n';
import { createAppRouter } from '../src/router';

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown };

let handler: Handler;
const calls: { url: string; init: RequestInit }[] = [];

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls.length = 0;
  setCsrfToken(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const { status, body } = handler(url, init);
      return json(status, body);
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

const session = (status: string, email = 'sacha@exemple.com') => ({
  status,
  csrfToken: 'jeton-csrf',
  user: { email },
});

describe('parcours de connexion', () => {
  it('redirige vers la connexion sans session', async () => {
    handler = () => ({ status: 401, body: { error: 'unauthorized' } });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Bon retour.' })).toBeTruthy();
  });

  it('affiche un message générique et vide le mot de passe en cas d’échec', async () => {
    handler = (url) =>
      url.endsWith('/auth/session')
        ? { status: 401, body: { error: 'unauthorized' } }
        : { status: 401, body: { error: 'invalid_credentials' } };
    renderApp('/connexion');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'sacha@exemple.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'mauvais');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Identifiants invalides.');
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).value).toBe('');
  });

  it('envoie les identifiants en JSON puis ouvre la boîte de réception', async () => {
    let loggedIn = false;
    handler = (url) => {
      if (url.endsWith('/auth/login')) {
        loggedIn = true;
        return { status: 200, body: session('ok') };
      }
      if (url.includes('/folders')) return { status: 200, body: { folders: [] } };
      if (url.includes('/labels')) return { status: 200, body: { labels: [] } };
      if (url.includes('/messages')) {
        return { status: 200, body: { messages: [], nextCursor: null, total: 0 } };
      }
      return loggedIn
        ? { status: 200, body: session('ok') }
        : { status: 401, body: { error: 'unauthorized' } };
    };
    renderApp('/connexion');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'sacha@exemple.com');
    await user.type(screen.getByLabelText('Mot de passe'), 'secret');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText('Aucun message.')).toBeTruthy();

    const loginCall = calls.find((c) => c.url.endsWith('/auth/login'));
    expect(loginCall?.init.method).toBe('POST');
    expect(loginCall?.init.credentials).toBe('same-origin');
    expect(JSON.parse(String(loginCall?.init.body))).toEqual({
      email: 'sacha@exemple.com',
      password: 'secret',
      remember: true,
    });
  });

  it('demande le second facteur quand il est requis', async () => {
    handler = (url) =>
      url.endsWith('/auth/session')
        ? { status: 200, body: session('totp_required') }
        : { status: 401, body: {} };
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'Vérification en deux étapes' }),
    ).toBeTruthy();
  });

  it('impose l’enrôlement quand la politique l’exige', async () => {
    handler = () => ({ status: 200, body: session('totp_enrollment_required') });
    renderApp('/parametres/securite');
    expect(
      await screen.findByRole('heading', { name: 'Activer la vérification en deux étapes' }),
    ).toBeTruthy();
  });

  it('joint le jeton CSRF aux requêtes modifiant l’état', async () => {
    handler = (url) =>
      url.endsWith('/auth/logout')
        ? { status: 204 }
        : url.endsWith('/auth/session')
          ? { status: 200, body: session('ok') }
          : { status: 401, body: {} };
    // La déconnexion est dans la navigation des paramètres.
    renderApp('/parametres');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/auth/logout'))).toBe(true));
    const logoutCall = calls.find((c) => c.url.endsWith('/auth/logout'));
    expect((logoutCall?.init.headers as Record<string, string>)['x-csrf-token']).toBe('jeton-csrf');
  });

  it('affiche une adresse malveillante comme du texte, sans l’interpréter', async () => {
    const payload = '<img src=x onerror="window.__xss=1">@exemple.com';
    handler = () => ({ status: 200, body: session('ok', payload) });
    renderApp('/');
    expect(await screen.findByText(payload)).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});
