import { ImapFlow } from 'imapflow';
import { imapOptions } from './imap.js';
import type { ServerTarget } from './server.js';

export interface PoolCredentials {
  target: ServerTarget;
  user: string;
  pass: string;
}

export class ImapAuthError extends Error {
  constructor() {
    super('imap_auth_failed');
    this.name = 'ImapAuthError';
  }
}

export class ImapUnavailableError extends Error {
  constructor() {
    super('imap_unavailable');
    this.name = 'ImapUnavailableError';
  }
}

interface Entry {
  client: ImapFlow;
  lastUsed: number;
}

export interface ImapPoolOptions {
  /** Durée d'inactivité après laquelle une connexion est fermée. */
  idleMs?: number;
  /** Nombre maximal de connexions simultanées (toutes les boîtes confondues). */
  maxConnections?: number;
}

/**
 * Connexions IMAP réutilisées par utilisateur pour les requêtes de l'API. Une connexion inactive
 * est fermée ; au-delà du plafond, la moins récemment utilisée est fermée.
 */
export class ImapPool {
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<ImapFlow>>();
  readonly #idleMs: number;
  readonly #max: number;
  readonly #timer: NodeJS.Timeout;

  constructor(
    private readonly credentials: (userId: string) => Promise<PoolCredentials>,
    options: ImapPoolOptions = {},
  ) {
    this.#idleMs = options.idleMs ?? 5 * 60_000;
    this.#max = options.maxConnections ?? 200;
    this.#timer = setInterval(() => this.#sweep(), 30_000);
    this.#timer.unref();
  }

  get size(): number {
    return this.#entries.size;
  }

  async acquire(userId: string): Promise<ImapFlow> {
    const entry = this.#entries.get(userId);
    if (entry && entry.client.usable) {
      entry.lastUsed = Date.now();
      return entry.client;
    }
    if (entry) this.#drop(userId);
    const pending = this.#pending.get(userId);
    if (pending) return pending;
    const promise = this.#connect(userId).finally(() => this.#pending.delete(userId));
    this.#pending.set(userId, promise);
    return promise;
  }

  async #connect(userId: string): Promise<ImapFlow> {
    const { target, user, pass } = await this.credentials(userId);
    const client = new ImapFlow(imapOptions(target, { user, pass }));
    client.on('error', () => this.#drop(userId));
    client.on('close', () => {
      if (this.#entries.get(userId)?.client === client) this.#entries.delete(userId);
    });
    try {
      await client.connect();
    } catch (error) {
      const err = error as { authenticationFailed?: boolean };
      if (err.authenticationFailed) throw new ImapAuthError();
      throw new ImapUnavailableError();
    }
    if (this.#entries.size >= this.#max) this.#evictOldest();
    this.#entries.set(userId, { client, lastUsed: Date.now() });
    return client;
  }

  /** Ferme la connexion d'un utilisateur (déconnexion, changement de mot de passe…). */
  release(userId: string): void {
    this.#drop(userId);
  }

  #drop(userId: string): void {
    const entry = this.#entries.get(userId);
    if (!entry) return;
    this.#entries.delete(userId);
    entry.client.logout().catch(() => entry.client.close());
  }

  #evictOldest(): void {
    let oldest: [string, Entry] | null = null;
    for (const item of this.#entries) {
      if (!oldest || item[1].lastUsed < oldest[1].lastUsed) oldest = item;
    }
    if (oldest) this.#drop(oldest[0]);
  }

  #sweep(): void {
    const now = Date.now();
    for (const [userId, entry] of this.#entries) {
      if (now - entry.lastUsed > this.#idleMs || !entry.client.usable) this.#drop(userId);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    for (const userId of [...this.#entries.keys()]) this.#drop(userId);
  }
}
