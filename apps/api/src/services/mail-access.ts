import { matchAccount, type PlumeConfig } from '@plume/config';
import {
  ImapFlow,
  ImapPool,
  imapOptions,
  loginFor,
  serverFor,
  smtpLoginFor,
  type PoolCredentials,
} from '@plume/mail';
import type { UserService } from './users.js';

export class AccountUnavailableError extends Error {
  constructor() {
    super('account_unavailable');
    this.name = 'AccountUnavailableError';
  }
}

/** Accès IMAP pour le compte d'un utilisateur : identifiants déchiffrés à la demande. */
export class MailAccess {
  readonly pool: ImapPool;

  constructor(
    private readonly users: UserService,
    private readonly config: () => PlumeConfig,
  ) {
    this.pool = new ImapPool((userId) => this.credentials(userId));
  }

  async credentials(userId: string): Promise<PoolCredentials> {
    const user = await this.users.get(userId);
    if (!user || user.suspendedAt) throw new AccountUnavailableError();
    // L'hôte provient toujours de la liste blanche, jamais d'une donnée fournie par l'utilisateur.
    const domain = matchAccount(this.config().domains, user.email);
    if (!domain) throw new AccountUnavailableError();
    const pass = await this.users.readImapPassword(userId);
    if (!pass) throw new AccountUnavailableError();
    return { target: serverFor(domain, 'imap'), user: loginFor(domain, user.email), pass };
  }

  /**
   * Identifiants SMTP : serveur SMTP du domaine (liste blanche), avec le compte de la boîte ou le
   * relais commun du domaine.
   */
  async smtpCredentials(
    userId: string,
  ): Promise<PoolCredentials & { from: string; relay: boolean }> {
    const user = await this.users.get(userId);
    if (!user || user.suspendedAt) throw new AccountUnavailableError();
    const domain = matchAccount(this.config().domains, user.email);
    if (!domain) throw new AccountUnavailableError();
    const pass = await this.users.readImapPassword(userId);
    if (!pass) throw new AccountUnavailableError();
    return {
      target: serverFor(domain, 'smtp'),
      ...smtpLoginFor(domain, user.email, pass),
      from: user.email,
    };
  }

  /** Connexion dédiée (IDLE) pour le flux d'événements temps réel. */
  async idleClient(userId: string): Promise<ImapFlow> {
    const { target, user, pass } = await this.credentials(userId);
    const client = new ImapFlow({
      ...imapOptions(target, { user, pass }),
      disableAutoIdle: false,
      maxIdleTime: 4 * 60_000,
    });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }
}
