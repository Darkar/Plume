-- Jalon 4 : préférences utilisateur (signature, thème, accent, densité, notifications).

CREATE TABLE preferences (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme           text NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
  accent          text NOT NULL DEFAULT 'indigo'
                  CHECK (accent IN ('indigo', 'blue', 'teal', 'green', 'orange', 'rose')),
  density         text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  notifications   jsonb NOT NULL DEFAULT '{"desktop": false, "sound": false, "dailyDigest": false}'::jsonb,
  -- HTML nettoyé côté serveur avant enregistrement.
  signature_html  text NOT NULL DEFAULT '' CHECK (length(signature_html) <= 20000),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
