-- Section 6 : « Reporter » un message. IMAP n'a pas de notion de report : le message est
-- déplacé dans un dossier dédié, puis remis dans la boîte de réception à l'échéance.

CREATE TABLE snoozes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Position du message dans le dossier des reports (peut devenir périmée : repli sur Message-ID).
  folder        text NOT NULL,
  uid_validity  bigint NOT NULL,
  uid           bigint NOT NULL,
  message_id    text CHECK (message_id IS NULL OR length(message_id) <= 255),
  -- Dossier où le message était avant le report (destination du réveil).
  return_to     text NOT NULL,
  wake_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, folder, uid_validity, uid)
);
CREATE INDEX snoozes_wake_idx ON snoozes (wake_at);

-- Idempotence du moteur de règles par Message-ID (empreinte SHA-256) : un message remis dans la
-- boîte de réception (réveil d'un report, « Annuler » d'un archivage) y reçoit un nouvel UID
-- mais ne doit pas être traité une seconde fois.
CREATE TABLE processed_message_ids (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_hash   bytea NOT NULL CHECK (length(message_hash) = 32),
  processed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_hash)
);
CREATE INDEX processed_message_ids_age_idx ON processed_message_ids (processed_at);
