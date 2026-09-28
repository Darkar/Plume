import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { tlsOptions, type ServerTarget } from './server.js';

export type ImapLoginResult = 'ok' | 'invalid' | 'unavailable';

export interface ImapTimeouts {
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
}

const DEFAULT_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 60_000,
} satisfies ImapTimeouts;

export function imapOptions(
  target: ServerTarget,
  auth: { user: string; pass: string },
  timeouts: ImapTimeouts = {},
): ImapFlowOptions {
  return {
    host: target.host,
    port: target.port,
    secure: target.security === 'tls',
    // En STARTTLS, la mise à niveau est obligatoire : jamais d'authentification en clair.
    doSTARTTLS: target.security === 'starttls' ? true : undefined,
    tls: tlsOptions(target),
    auth,
    logger: false,
    disableAutoIdle: true,
    // Décodage des parties MIME côté client : certains serveurs annoncent FETCH BINARY sans
    // décoder réellement le contenu, ce qui produirait un corps encore encodé.
    disableBinary: true,
    clientInfo: { name: 'Plume' },
    ...DEFAULT_TIMEOUTS,
    ...timeouts,
  };
}

/**
 * Vérifie des identifiants par un LOGIN IMAP. Ne lève jamais : distingue un refus du serveur
 * (« invalid ») d'une indisponibilité (« unavailable »), pour ne pas compter une panne réseau
 * comme une tentative de force brute.
 */
export async function verifyImapLogin(
  target: ServerTarget,
  user: string,
  pass: string,
  timeouts: ImapTimeouts = {},
): Promise<ImapLoginResult> {
  // Refuse avant toute connexion ce qui ne peut pas être transmis proprement au serveur.
  if (!user || !pass || /[\r\n\0]/.test(user) || /[\r\n\0]/.test(pass) || pass.length > 1024) {
    return 'invalid';
  }
  const client = new ImapFlow({
    ...imapOptions(target, { user, pass }, timeouts),
    verifyOnly: true,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return 'ok';
  } catch (error) {
    const err = error as { authenticationFailed?: boolean; serverResponseCode?: string };
    if (err.authenticationFailed || err.serverResponseCode === 'AUTHENTICATIONFAILED') {
      return 'invalid';
    }
    return 'unavailable';
  } finally {
    client.close();
  }
}

export { ImapFlow };
