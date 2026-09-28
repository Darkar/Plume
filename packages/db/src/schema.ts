import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Colonne bytea (Buffer). */
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

// Miroir TypeScript des migrations SQL (packages/db/migrations) : toute modification du schéma
// passe par une nouvelle migration, puis par la mise à jour de ce fichier.

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    domain: text('domain').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  },
  (t) => [index('users_domain_idx').on(t.domain)],
);

export const credentials = pgTable('credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  keyId: text('key_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const totp = pgTable('totp', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  keyId: text('key_id').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
});

export const backupCodes = pgTable('backup_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  subject: text('subject'),
  event: text('event').notNull(),
  ip: inet('ip'),
  metadata: jsonb('metadata')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const preferences = pgTable('preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme', { enum: ['auto', 'light', 'dark'] })
    .notNull()
    .default('auto'),
  accent: text('accent', { enum: ['indigo', 'blue', 'teal', 'green', 'orange', 'rose'] })
    .notNull()
    .default('indigo'),
  density: text('density', { enum: ['comfortable', 'compact'] })
    .notNull()
    .default('comfortable'),
  notifications: jsonb('notifications')
    .$type<{ desktop: boolean; sound: boolean; dailyDigest: boolean }>()
    .notNull()
    .default({ desktop: false, sound: false, dailyDigest: false }),
  signatureHtml: text('signature_html').notNull().default(''),
  language: text('language', { enum: ['auto', 'fr', 'en'] })
    .notNull()
    .default('auto'),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    definition: jsonb('definition').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    processedCount: bigint('processed_count', { mode: 'number' }).notNull().default(0),
    errorCount: bigint('error_count', { mode: 'number' }).notNull().default(0),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  },
  (t) => [index('rules_user_position_idx').on(t.userId, t.position)],
);

export const processedMessages = pgTable(
  'processed_messages',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mailbox: text('mailbox').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    uid: bigint('uid', { mode: 'number' }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.mailbox, t.uidValidity, t.uid] })],
);

export const ruleCursors = pgTable(
  'rule_cursors',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mailbox: text('mailbox').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    lastUid: bigint('last_uid', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.mailbox] })],
);

export const autoReplies = pgTable(
  'auto_replies',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sender: text('sender').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sender] })],
);

export const snoozes = pgTable(
  'snoozes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    folder: text('folder').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    uid: bigint('uid', { mode: 'number' }).notNull(),
    messageId: text('message_id'),
    returnTo: text('return_to').notNull(),
    wakeAt: timestamp('wake_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('snoozes_wake_idx').on(t.wakeAt)],
);

export const avatars = pgTable('avatars', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  image: bytea('image').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Snooze = typeof snoozes.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type Preferences = typeof preferences.$inferSelect;
