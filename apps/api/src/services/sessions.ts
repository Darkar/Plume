import { createHash } from 'node:crypto';
import { randomToken } from '@plume/crypto';
import type { Redis } from 'ioredis';

export type SessionStage = 'full' | 'totp' | 'enroll';

/** Compte ouvert dans une session. */
export interface SessionAccount {
  userId: string;
  email: string;
  domain: string;
}

/** Nombre maximal de comptes ouverts dans une même session. */
export const MAX_SESSION_ACCOUNTS = 5;

export interface SessionData {
  /** Compte actif : toutes les routes agissent pour lui. */
  userId: string;
  email: string;
  domain: string;
  /**
   * Comptes ouverts dans la session (compte actif compris), chacun ajouté après une
   * authentification complète. Absent : un seul compte.
   */
  accounts?: SessionAccount[];
  /** Compte en cours d'ajout, en attente de son second facteur. */
  pendingAccount?: SessionAccount & { attemptsLeft: number; expiresAt: number };
  stage: SessionStage;
  csrf: string;
  remember: boolean;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  idleTimeoutMs: number;
  /** Tentatives de second facteur restantes pour une session partielle. */
  attemptsLeft: number;
  /** Secret TOTP en cours d'enrôlement, chiffré (jamais en clair dans Redis). */
  pendingTotp?: string;
}

export interface SessionPolicy {
  sessionTtl: number;
  idleTimeout: number;
  rememberMeTtl: number;
}

/** Délai d'inactivité d'une session « se souvenir de moi » (plafonné par sa durée absolue). */
export const REMEMBER_IDLE_MS = 7 * 86_400_000;
/** Durée de vie d'une session en attente du second facteur. */
export const PARTIAL_SESSION_TTL_MS = 5 * 60_000;
export const MAX_SECOND_FACTOR_ATTEMPTS = 5;

/** Comptes d'une session (le compte actif seul si la session n'en a qu'un). */
export function sessionAccounts(session: SessionData): SessionAccount[] {
  return session.accounts && session.accounts.length > 0
    ? session.accounts
    : [{ userId: session.userId, email: session.email, domain: session.domain }];
}

const PREFIX = 'plume:sess:';
const USER_PREFIX = 'plume:user-sess:';

/**
 * Sessions stockées dans Redis. La clé Redis est l'empreinte SHA-256 de l'identifiant : un
 * accès en lecture à Redis ne permet pas de réutiliser les sessions.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  static hash(id: string): string {
    return createHash('sha256').update(id).digest('hex');
  }

  async create(input: {
    userId: string;
    email: string;
    domain: string;
    stage: SessionStage;
    remember: boolean;
    policy: SessionPolicy;
  }): Promise<{ id: string; session: SessionData }> {
    const now = this.now();
    const partial = input.stage === 'totp';
    const absolute = partial
      ? PARTIAL_SESSION_TTL_MS
      : input.remember
        ? input.policy.rememberMeTtl
        : input.policy.sessionTtl;
    const idle = partial
      ? PARTIAL_SESSION_TTL_MS
      : input.remember
        ? Math.min(REMEMBER_IDLE_MS, absolute)
        : input.policy.idleTimeout;
    const session: SessionData = {
      userId: input.userId,
      email: input.email,
      domain: input.domain,
      stage: input.stage,
      csrf: randomToken(),
      remember: input.remember && !partial,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + absolute,
      idleTimeoutMs: idle,
      attemptsLeft: MAX_SECOND_FACTOR_ATTEMPTS,
    };
    const id = randomToken(32); // 256 bits
    await this.#write(SessionStore.hash(id), session);
    return { id, session };
  }

  async #write(hash: string, session: SessionData): Promise<void> {
    const ttl = Math.min(session.idleTimeoutMs, session.absoluteExpiresAt - this.now());
    if (ttl <= 0) {
      await this.#remove(hash, session);
      return;
    }
    // Index par compte : « déconnecter tous mes appareils » d'un compte ferme aussi les
    // sessions où il a été ajouté.
    const lifetime = session.absoluteExpiresAt - this.now();
    const tx = this.redis.multi().set(PREFIX + hash, JSON.stringify(session), 'PX', ttl);
    for (const account of sessionAccounts(session)) {
      tx.sadd(USER_PREFIX + account.userId, hash).pexpire(
        USER_PREFIX + account.userId,
        lifetime,
        'GT',
      );
    }
    await tx.exec();
    // PEXPIRE … GT n'agit pas sur une clé sans TTL : on garantit une expiration.
    for (const account of sessionAccounts(session)) {
      await this.redis.pexpire(USER_PREFIX + account.userId, lifetime, 'NX');
    }
  }

  async #remove(hash: string, session?: SessionData | string): Promise<void> {
    const tx = this.redis.multi().del(PREFIX + hash);
    const userIds =
      typeof session === 'string'
        ? [session]
        : session
          ? sessionAccounts(session).map((a) => a.userId)
          : [];
    for (const userId of userIds) tx.srem(USER_PREFIX + userId, hash);
    await tx.exec();
  }

  /**
   * Remplace l'identifiant d'une session (anti-fixation, ex. après l'ajout d'un compte) : l'ancien
   * identifiant cesse aussitôt d'être valide.
   */
  async rotate(id: string, session: SessionData): Promise<string> {
    await this.#remove(SessionStore.hash(id), session);
    const next = randomToken(32);
    await this.#write(SessionStore.hash(next), session);
    return next;
  }

  /** Retire un compte de l'index (compte retiré de la session). */
  async unindex(id: string, userId: string): Promise<void> {
    await this.redis.srem(USER_PREFIX + userId, SessionStore.hash(id));
  }

  /** Lit une session valide et prolonge son délai d'inactivité. */
  async touch(id: string): Promise<SessionData | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const hash = SessionStore.hash(id);
    const raw = await this.redis.get(PREFIX + hash);
    if (!raw) return null;
    let session: SessionData;
    try {
      session = JSON.parse(raw) as SessionData;
    } catch {
      await this.#remove(hash);
      return null;
    }
    const now = this.now();
    if (now >= session.absoluteExpiresAt || now - session.lastSeenAt >= session.idleTimeoutMs) {
      await this.#remove(hash, session);
      return null;
    }
    session.lastSeenAt = now;
    await this.#write(hash, session);
    return session;
  }

  /** Lit une session sans prolonger son délai d'inactivité (flux d'événements). */
  async peek(id: string): Promise<SessionData | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const raw = await this.redis.get(PREFIX + SessionStore.hash(id));
    if (!raw) return null;
    const session = JSON.parse(raw) as SessionData;
    const now = this.now();
    if (now >= session.absoluteExpiresAt || now - session.lastSeenAt >= session.idleTimeoutMs)
      return null;
    return session;
  }

  async update(id: string, session: SessionData): Promise<void> {
    await this.#write(SessionStore.hash(id), session);
  }

  async destroy(id: string): Promise<void> {
    const hash = SessionStore.hash(id);
    const raw = await this.redis.get(PREFIX + hash);
    await this.#remove(hash, raw ? (JSON.parse(raw) as SessionData) : undefined);
  }

  /** Supprime toutes les sessions d'un utilisateur (« déconnecter tous mes appareils »). */
  async destroyAllForUser(userId: string): Promise<number> {
    const hashes = await this.redis.smembers(USER_PREFIX + userId);
    if (hashes.length === 0) return 0;
    const deleted = await this.redis.del(...hashes.map((h) => PREFIX + h));
    await this.redis.del(USER_PREFIX + userId);
    return deleted;
  }
}
