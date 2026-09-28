-- Jalon 2 : utilisateurs, identifiants chiffrés, TOTP, codes de secours, journal d'audit.

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  domain          text NOT NULL CHECK (domain = lower(domain)),
  display_name    text CHECK (display_name IS NULL OR length(display_name) <= 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  -- Posé quand le domaine est retiré de la liste blanche : sessions révoquées, règles suspendues.
  suspended_at    timestamptz
);
CREATE INDEX users_domain_idx ON users (domain);

-- Mot de passe IMAP chiffré (AES-256-GCM, clé dérivée par utilisateur), pour le moteur de règles.
CREATE TABLE credentials (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret      text NOT NULL,
  key_id      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE totp (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret          text NOT NULL,          -- chiffré (contexte « totp »)
  key_id          text NOT NULL,
  enabled_at      timestamptz NOT NULL DEFAULT now(),
  last_used_step  bigint                  -- anti-rejeu : dernier pas de temps accepté
);

CREATE TABLE backup_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash   text NOT NULL,              -- Argon2id
  used_at     timestamptz
);
CREATE INDEX backup_codes_user_idx ON backup_codes (user_id) WHERE used_at IS NULL;

-- Journal d'audit : jamais de mot de passe, de jeton ni de contenu de mail.
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Adresse tentée, y compris pour un échec sur un compte inexistant (normalisée ou tronquée).
  subject     text CHECK (subject IS NULL OR length(subject) <= 254),
  event       text NOT NULL CHECK (length(event) <= 64),
  ip          inet,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
