import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api/client';
import { I18nProvider } from '../src/i18n';
import { createAppRouter } from '../src/router';

let prefs: Record<string, unknown>;
const calls: { url: string; method: string; body: unknown }[] = [];

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {}
}

beforeEach(() => {
  setCsrfToken(null);
  calls.length = 0;
  prefs = {
    theme: 'auto',
    accent: 'indigo',
    density: 'comfortable',
    language: 'fr',
    notifications: { desktop: false, sound: false, dailyDigest: false },
    signatureHtml: '<p>Sig</p>',
    displayName: 'Sacha',
    hasAvatar: false,
    limits: { maxAttachmentSize: 100, maxUploadTotal: 200 },
  };
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.endsWith('/auth/session')) {
        return json(200, { status: 'ok', csrfToken: 'c', user: { email: 'j@exemple.com' } });
      }
      if (url.endsWith('/me/preferences') && method === 'PATCH') {
        prefs = {
          ...prefs,
          ...body,
          notifications: { ...(prefs.notifications as object), ...(body.notifications ?? {}) },
        };
        return json(200, prefs);
      }
      if (url.endsWith('/me/preferences')) return json(200, prefs);
      if (url.endsWith('/me/avatar'))
        return json(
          method === 'PUT' ? 422 : 204,
          method === 'PUT' ? { error: 'invalid_image' } : undefined,
        );
      if (url.endsWith('/api/v1/me')) {
        return json(200, {
          id: 'u',
          email: 'j@exemple.com',
          displayName: null,
          totp: { policy: 'optional', enabled: true, backupCodesRemaining: 7 },
          csrfToken: 'c',
        });
      }
      if (url.endsWith('/auth/logout-all')) return json(204);
      if (url.endsWith('/folders')) return json(200, { folders: [] });
      if (url.endsWith('/labels')) return json(200, { labels: [] });
      return json(404, { error: 'not_found' });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.setAttribute('lang', 'fr');
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

describe('Paramètres › Général', () => {
  it('applique le thème et l’accent immédiatement et les enregistre', async () => {
    const user = userEvent.setup();
    renderAt('/parametres');
    await user.click(await screen.findByRole('radio', { name: 'Sombre' }));
    expect((screen.getByRole('radio', { name: 'Sombre' }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    await user.click(screen.getByRole('radio', { name: 'Vert' }));
    await waitFor(() => expect(document.documentElement.getAttribute('data-accent')).toBe('green'));
    await user.click(screen.getByRole('radio', { name: 'Compacte' }));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-density')).toBe('compact'),
    );
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    expect(patches).toEqual([{ theme: 'dark' }, { accent: 'green' }, { density: 'compact' }]);
  });

  it('change la langue de l’interface', async () => {
    const user = userEvent.setup();
    renderAt('/parametres');
    await user.selectOptions(await screen.findByLabelText('Langue'), 'en');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('enregistre les notifications et affiche une photo refusée', async () => {
    const user = userEvent.setup();
    renderAt('/parametres');
    await user.click(await screen.findByLabelText(/Son à l’arrivée/));
    await user.click(screen.getByLabelText(/Résumé quotidien/));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(prefs.notifications).toMatchObject({ sound: true, dailyDigest: true });
    await user.upload(
      screen.getByLabelText('Changer la photo'),
      new File(['pas une image'], 'photo.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('Image illisible ou trop volumineuse.')).toBeTruthy();
  });

  it('enregistre le nom affiché et la signature', async () => {
    const user = userEvent.setup();
    renderAt('/parametres');
    const name = await screen.findByLabelText('Nom affiché');
    await user.clear(name);
    await user.type(name, 'J. M.');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ displayName: 'J. M.' }),
    );
    expect(await screen.findByText('Préférences enregistrées.')).toBeTruthy();
  });
});

describe('Paramètres › Sécurité', () => {
  it('affiche l’état du TOTP et déconnecte tous les appareils', async () => {
    const user = userEvent.setup();
    renderAt('/parametres/securite');
    expect(await screen.findByText('Activée — 7 code(s) de secours restant(s).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Déconnecter tous mes appareils' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/auth/logout-all'))).toBe(true));
  });
});

describe('notifications temps réel', () => {
  it('notifie le nombre de nouveaux messages (jamais leur contenu) et joue un son', async () => {
    prefs = { ...prefs, notifications: { desktop: true, sound: true, dailyDigest: false } };
    const shown: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body?: string }) {
        shown.push({ title, body: options.body });
      }
      close() {}
    }
    const oscillators: number[] = [];
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createOscillator() {
        oscillators.push(1);
        return {
          type: '',
          frequency: { value: 0 },
          connect: (n: unknown) => n,
          start() {},
          stop() {},
          onended: null,
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect: (n: unknown) => n,
        };
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderAt('/parametres');
    await screen.findByRole('heading', { name: 'Paramètres', level: 1 });
    act(() => FakeEventSource.last!.emit('mailbox', { folder: 'INBOX', exists: 5, previous: 3 }));
    expect(shown).toEqual([{ title: 'Plume', body: '2 nouveau(x) message(s)' }]);
    expect(oscillators).toHaveLength(1);
    // Un message supprimé n'est pas une arrivée.
    act(() => FakeEventSource.last!.emit('mailbox', { folder: 'INBOX', exists: 4, previous: 5 }));
    expect(shown).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    void within;
  });
});
