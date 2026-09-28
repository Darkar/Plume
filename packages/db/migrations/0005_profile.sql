-- Jalon 6 : langue de l'interface, résumé quotidien, photo de profil.

ALTER TABLE preferences
  ADD COLUMN language text NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'fr', 'en')),
  ADD COLUMN last_digest_at timestamptz;

-- Photo réencodée côté serveur (WebP 256 × 256, sans métadonnées) : quelques dizaines de Ko.
CREATE TABLE avatars (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  image       bytea NOT NULL CHECK (length(image) <= 262144),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
