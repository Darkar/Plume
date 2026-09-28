-- Jalon 5 : moteur de règles.

CREATE TABLE rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position >= 0),
  -- Définition complète (validée par le schéma Zod de packages/rules avant écriture).
  definition       jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_run_at      timestamptz,
  processed_count  bigint NOT NULL DEFAULT 0,
  error_count      bigint NOT NULL DEFAULT 0,
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 64),
  last_error_at    timestamptz
);
CREATE INDEX rules_user_position_idx ON rules (user_id, position);

-- Idempotence : un message (boîte + UIDVALIDITY + UID) n'est jamais traité deux fois.
CREATE TABLE processed_messages (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mailbox       text NOT NULL,
  uid_validity  bigint NOT NULL,
  uid           bigint NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mailbox, uid_validity, uid)
);
CREATE INDEX processed_messages_age_idx ON processed_messages (processed_at);

-- Position de lecture par boîte : seuls les messages arrivés ensuite sont traités.
CREATE TABLE rule_cursors (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mailbox       text NOT NULL,
  uid_validity  bigint NOT NULL,
  last_uid      bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mailbox)
);

-- Réponses automatiques : au plus une par expéditeur et par 24 h.
CREATE TABLE auto_replies (
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sender    text NOT NULL CHECK (sender = lower(sender) AND length(sender) <= 254),
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender)
);
