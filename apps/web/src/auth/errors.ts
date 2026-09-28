import { ApiError } from '../api/client';
import type { MessageKey } from '../i18n/fr';

/** Traduit une erreur d'API en message affichable (jamais le détail technique). */
export function errorMessageKey(
  error: unknown,
  fallback: MessageKey = 'common.error.generic',
): MessageKey {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'auth.login.error.invalid';
      case 'too_many_attempts':
        return 'auth.login.error.tooMany';
      case 'invalid_origin':
      case 'invalid_csrf_token':
        return 'auth.login.error.origin';
      case 'invalid_code':
        return 'auth.totp.error.invalid';
      default:
        return fallback;
    }
  }
  if (error instanceof TypeError) return 'common.error.network';
  return fallback;
}
