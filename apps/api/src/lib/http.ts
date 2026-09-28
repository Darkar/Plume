/** Erreur HTTP applicative : le code est renvoyé au client, jamais le détail interne. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    /** Détails sûrs (codes, chemins) renvoyés au client, jamais de données internes. */
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized');
export const forbidden = (code = 'forbidden') => new HttpError(403, code);
export const badRequest = (code = 'invalid_request') => new HttpError(400, code);
export const notFound = () => new HttpError(404, 'not_found');

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
