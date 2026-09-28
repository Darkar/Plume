import type { SessionStatus } from './api';

/** Page vers laquelle diriger l'utilisateur selon l'état de sa session. */
export function destinationFor(
  status: SessionStatus,
): '/' | '/connexion/verification' | '/securite/activation' {
  switch (status) {
    case 'totp_required':
      return '/connexion/verification';
    case 'totp_enrollment_required':
      return '/securite/activation';
    default:
      return '/';
  }
}
