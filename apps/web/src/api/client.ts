/** Client HTTP de l'API : JSON uniquement, cookies de même origine, jeton CSRF en mémoire. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Corps de la réponse d'erreur (codes de validation, jamais de données internes). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;

/** Le jeton CSRF n'est jamais stocké durablement (ni localStorage, ni cookie lisible). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const BASE = '/api/v1';

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;
  let data: unknown = null;
  if (response.headers.get('content-type')?.includes('application/json')) {
    data = await response.json();
  }
  if (!response.ok) {
    const code =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : 'unknown_error';
    throw new ApiError(
      response.status,
      code,
      data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    );
  }
  if (
    data &&
    typeof data === 'object' &&
    'csrfToken' in data &&
    typeof data.csrfToken === 'string'
  ) {
    setCsrfToken(data.csrfToken);
  }
  return data as T;
}
