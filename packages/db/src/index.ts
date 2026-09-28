export * from './client.js';
export * from './migrate.js';
export * from './rules-repo.js';
export * from './snoozes-repo.js';

/** Contexte de chiffrement du mot de passe IMAP (partagé par l'API et le worker). */
export const IMAP_PASSWORD_CONTEXT = 'imap-password';
export * as schema from './schema.js';
export type { Preferences, RuleRow, Snooze, User } from './schema.js';
