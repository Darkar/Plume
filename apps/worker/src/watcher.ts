import { ImapFlow, imapOptions } from '@plume/mail';
import type { Logger } from 'pino';
import type { AccountInfo } from './processor.js';

export interface WatcherDeps {
  logger: Logger;
  account: (userId: string) => Promise<AccountInfo | null>;
  /** Signale qu'un traitement est nécessaire (nouveau message, reconnexion…). */
  notify: (userId: string, mailbox: string) => void;
  /** Nombre maximal de connexions IDLE simultanées (au-delà : interrogation périodique). */
  maxConnections?: number;
}

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

interface Watch {
  client: ImapFlow | null;
  stopped: boolean;
  failures: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Une connexion IMAP IDLE par compte ayant des règles actives. Reconnexion à délai croissant
 * (2 s → 5 min) ; les comptes au-delà du plafond sont couverts par l'interrogation périodique.
 */
export class IdleWatchers {
  readonly #watches = new Map<string, Watch>();
  readonly #max: number;

  constructor(private readonly deps: WatcherDeps) {
    this.#max = deps.maxConnections ?? 500;
  }

  get watching(): string[] {
    return [...this.#watches.keys()];
  }

  /** Aligne l'ensemble des comptes surveillés sur la liste donnée. */
  sync(userIds: string[]): void {
    const wanted = new Set(userIds.slice(0, this.#max));
    for (const userId of this.#watches.keys()) if (!wanted.has(userId)) this.stop(userId);
    for (const userId of wanted) if (!this.#watches.has(userId)) this.start(userId);
  }

  start(userId: string): void {
    if (this.#watches.has(userId) || this.#watches.size >= this.#max) return;
    const watch: Watch = { client: null, stopped: false, failures: 0, timer: null };
    this.#watches.set(userId, watch);
    void this.#connect(userId, watch);
  }

  stop(userId: string): void {
    const watch = this.#watches.get(userId);
    if (!watch) return;
    watch.stopped = true;
    if (watch.timer) clearTimeout(watch.timer);
    watch.client?.logout().catch(() => watch.client?.close());
    this.#watches.delete(userId);
  }

  #schedule(userId: string, watch: Watch): void {
    if (watch.stopped) return;
    watch.failures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(watch.failures - 1, 10));
    const jitter = Math.floor(Math.random() * 1000);
    watch.timer = setTimeout(() => void this.#connect(userId, watch), delay + jitter);
    watch.timer.unref();
  }

  async #connect(userId: string, watch: Watch): Promise<void> {
    if (watch.stopped) return;
    const account = await this.deps.account(userId).catch(() => null);
    if (!account) {
      // Compte suspendu ou identifiants illisibles : on arrête de surveiller.
      this.deps.logger.warn({ userId }, 'surveillance IMAP impossible : compte indisponible');
      this.stop(userId);
      return;
    }
    const client = new ImapFlow({
      ...imapOptions(account.imap.target, { user: account.imap.user, pass: account.imap.pass }),
      disableAutoIdle: false,
      maxIdleTime: 4 * 60_000,
    });
    watch.client = client;
    let retried = false;
    const retry = () => {
      if (retried) return;
      retried = true;
      if (watch.client === client) watch.client = null;
      this.#schedule(userId, watch);
    };
    client.on('error', () => undefined);
    client.on('exists', (info: { path: string }) => this.deps.notify(userId, info.path));
    client.on('close', retry);
    try {
      await client.connect();
      await client.mailboxOpen('INBOX', { readOnly: true });
      watch.failures = 0;
      // Messages arrivés pendant la déconnexion : un passage de rattrapage.
      this.deps.notify(userId, 'INBOX');
    } catch (error) {
      const auth = (error as { authenticationFailed?: boolean }).authenticationFailed;
      this.deps.logger.warn({ userId, auth: Boolean(auth) }, 'connexion IDLE impossible');
      client.close();
      retry();
    }
  }

  async close(): Promise<void> {
    for (const userId of [...this.#watches.keys()]) this.stop(userId);
  }
}
