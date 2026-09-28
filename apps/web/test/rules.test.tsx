import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../src/api/client';
import { I18nProvider } from '../src/i18n';
import { createAppRouter } from '../src/router';

const withHeader = (id: string, name: string) => ({
  ...rule(id, name),
  conditions: [{ field: 'header:x-spam-flag', op: 'equals', value: 'yes' }],
});

const rule = (id: string, name: string) => ({
  id,
  name,
  position: 0,
  enabled: true,
  match: 'all',
  conditions: [{ field: 'subject', op: 'contains', value: 'facture' }],
  actions: [{ type: 'mark_read' }],
  stop_processing: false,
  stats: { lastRunAt: null, processedCount: 3, errorCount: 0, lastError: null },
});

const calls: { url: string; method: string; body: unknown }[] = [];
let createResponse: { status: number; body: unknown };

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  setCsrfToken(null);
  calls.length = 0;
  createResponse = { status: 201, body: rule('c', 'Nouvelle') };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/auth/session'))
        return json(200, { status: 'ok', csrfToken: 'c', user: { email: 'j@exemple.com' } });
      if (url.endsWith('/folders')) return json(200, { folders: [] });
      if (url.endsWith('/rules/reorder'))
        // Réponse réelle de l'API : les règles seulement, sans les limites.
        return json(200, { rules: [rule('b', 'B'), rule('a', 'A')] });
      if (url.endsWith('/rules') && method === 'POST')
        return json(createResponse.status, createResponse.body);
      if (url.endsWith('/rules'))
        return json(200, {
          rules: [rule('a', 'A'), withHeader('b', 'B')],
          limits: {
            enabled: true,
            maxRules: 100,
            forward: { enabled: true, domains: [] },
            allowedHeaders: ['list-id', 'x-spam-flag'],
          },
        });
      if (url.includes('/messages/bXNn')) {
        return json(200, {
          id: 'bXNn',
          folder: 'INBOX',
          subject: 'Votre facture',
          from: [{ name: 'Nimbus', address: 'f@nimbus.example' }],
          to: [],
          cc: [],
          replyTo: [],
          date: null,
          size: 1,
          seen: true,
          flagged: false,
          answered: false,
          keywords: [],
          hasAttachments: false,
          messageId: null,
          attachments: [],
          remoteImagesPolicy: 'block_by_default',
          blockedRemoteImages: 0,
        });
      }
      return json(404, { error: 'not_found' });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRules(path = '/parametres/regles') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient);
  router.update({
    history: createMemoryHistory({ initialEntries: [path] }),
  } as never);
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('règles', () => {
  it('réordonne au clavier via des boutons accessibles', async () => {
    const user = userEvent.setup();
    renderRules();
    await user.click(await screen.findByRole('button', { name: 'Descendre la règle A' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/rules/reorder'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/rules/reorder'))?.body).toEqual({ ids: ['b', 'a'] });
    // La page reste affichée après la réponse du serveur (qui ne contient pas les limites).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('button', { name: 'Nouvelle règle' })).toBeTruthy();
  });

  it('affiche les erreurs de validation du serveur', async () => {
    createResponse = {
      status: 400,
      body: {
        error: 'invalid_rule',
        issues: [{ code: 'forward_destination_not_allowed', actionIndex: 0 }],
      },
    };
    const user = userEvent.setup();
    renderRules();
    await user.click(await screen.findByRole('button', { name: 'Nouvelle règle' }));
    await user.type(screen.getByLabelText('Nom de la règle'), 'Transfert');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la règle' }));
    expect(
      await screen.findByText('Ce domaine de destination n’est pas autorisé pour le transfert.'),
    ).toBeTruthy();
  });

  it('conserve une condition sur un en-tête à la modification', async () => {
    const user = userEvent.setup();
    renderRules();
    const buttons = await screen.findAllByRole('button', { name: 'Modifier' });
    await user.click(buttons[1]!);
    expect((screen.getByLabelText('Champ') as HTMLSelectElement).value).toBe('header');
    expect((screen.getByLabelText('Nom de l’en-tête') as HTMLSelectElement).value).toBe(
      'x-spam-flag',
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer la règle' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(
      (calls.find((c) => c.method === 'PATCH')?.body as { conditions: unknown[] }).conditions,
    ).toEqual([{ field: 'header:x-spam-flag', op: 'equals', value: 'yes' }]);
  });

  it('duplique une règle', async () => {
    const user = userEvent.setup();
    renderRules();
    await user.click((await screen.findAllByRole('button', { name: 'Dupliquer' }))[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/rules'))).toBe(true),
    );
    expect((calls.find((c) => c.method === 'POST')?.body as { name: string }).name).toBe(
      'A (copie)',
    );
  });

  it('réordonne par glisser-déposer', async () => {
    renderRules();
    const first = (await screen.findByRole('heading', { name: 'A' })).closest('li') as HTMLElement;
    const second = screen.getByRole('heading', { name: 'B' }).closest('li') as HTMLElement;
    const data = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(first, { dataTransfer: data });
    fireEvent.dragOver(second, { dataTransfer: data });
    fireEvent.drop(second, { dataTransfer: data });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/rules/reorder'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/rules/reorder'))?.body).toEqual({ ids: ['b', 'a'] });
    // La page reste affichée après la réponse du serveur (qui ne contient pas les limites).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('button', { name: 'Nouvelle règle' })).toBeTruthy();
  });

  it('pré-remplit une règle à partir d’un message', async () => {
    renderRules('/parametres/regles?depuis=bXNn');
    expect(((await screen.findByLabelText('Nom de la règle')) as HTMLInputElement).value).toBe(
      'Messages de Nimbus',
    );
    const values = (screen.getAllByLabelText('Valeur') as HTMLInputElement[]).map((i) => i.value);
    expect(values).toEqual(['f@nimbus.example', 'Votre facture']);
  });
});
