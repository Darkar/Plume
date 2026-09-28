import type { DomainConfig, PlumeConfig } from '@plume/config';
import type { SecretBox } from '@plume/crypto';
import { RulesRepository, SnoozesRepository, type DbHandle } from '@plume/db';
import type { FetchedImage, ImapLoginResult } from '@plume/mail';
import type { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { RULES_CHANGED_CHANNEL, RULES_QUEUE } from '@plume/shared';
import type { Logger } from 'pino';
import { AuditLog } from './services/audit.js';
import type { UrlSigner } from './lib/signing.js';
import { Limiter } from './services/limiter.js';
import { MailAccess } from './services/mail-access.js';
import { PreferencesService } from './services/preferences.js';
import { SessionStore } from './services/sessions.js';
import { UserService } from './services/users.js';

export type LoginVerifier = (
  domain: DomainConfig,
  email: string,
  password: string,
) => Promise<ImapLoginResult>;

export interface ServiceDeps {
  db: DbHandle;
  redis: Redis;
  box: SecretBox;
  verifyLogin: LoginVerifier;
  signer: UrlSigner;
  /** Récupération d'une image distante (proxy anti-SSRF). */
  fetchImage: (url: string) => Promise<FetchedImage>;
  now?: () => number;
  /**
   * Durée minimale (ms) d'une réponse de connexion en échec : masque par le temps de réponse la
   * différence entre un domaine refusé (aucune connexion IMAP) et un mauvais mot de passe.
   */
  failureDelay?: () => number;
}

export interface Services {
  config: () => PlumeConfig;
  logger: Logger;
  db: DbHandle;
  redis: Redis;
  box: SecretBox;
  verifyLogin: LoginVerifier;
  signer: UrlSigner;
  fetchImage: (url: string) => Promise<FetchedImage>;
  mail: MailAccess;
  preferences: PreferencesService;
  rules: RulesRepository;
  snoozes: SnoozesRepository;
  rulesQueue: Queue;
  /** Prévient le worker qu'un utilisateur a modifié ses règles. */
  rulesChanged: (userId: string) => Promise<void>;
  now: () => number;
  failureDelay: () => number;
  sessions: SessionStore;
  limiter: Limiter;
  audit: AuditLog;
  users: UserService;
}

export function defaultFailureDelay(): number {
  return 600 + Math.floor(Math.random() * 400);
}

export function createServices(
  config: () => PlumeConfig,
  logger: Logger,
  deps: ServiceDeps,
): Services {
  const now = deps.now ?? Date.now;
  const users = new UserService(deps.db.db, deps.box);
  return {
    config,
    logger,
    db: deps.db,
    redis: deps.redis,
    box: deps.box,
    verifyLogin: deps.verifyLogin,
    signer: deps.signer,
    fetchImage: deps.fetchImage,
    mail: new MailAccess(users, config),
    preferences: new PreferencesService(deps.db.db),
    rules: new RulesRepository(deps.db.db),
    snoozes: new SnoozesRepository(deps.db.db),
    rulesQueue: new Queue(RULES_QUEUE, { connection: deps.redis }),
    rulesChanged: async (userId) => {
      await deps.redis.publish(RULES_CHANGED_CHANNEL, userId);
    },
    now,
    failureDelay: deps.failureDelay ?? defaultFailureDelay,
    sessions: new SessionStore(deps.redis, now),
    limiter: new Limiter(deps.redis),
    audit: new AuditLog(deps.db.db, logger),
    users,
  };
}
