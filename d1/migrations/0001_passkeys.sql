-- Website-Zugang mit Passkeys (Cloudflare D1 „chadoodle-auth“, Binding AUTH_DB).
-- Neue Nutzer kommen nur über Einladungslinks aus dem Admin-Dashboard dazu.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                -- zufällig, zugleich WebAuthn user.id
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,                -- Credential-ID (base64url)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,           -- COSE-Schlüssel (base64url)
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                    -- JSON-Liste
  label TEXT,                         -- z. B. „iPhone“, „Windows Hello“
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);

-- Einladungen: im Link steht nur das Token, gespeichert wird sein SHA-256
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,                 -- Name des neuen Nutzers (oder des bestehenden)
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- gesetzt: weiterer Passkey für diesen Nutzer
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);

-- Sitzungen: im Cookie steht nur das Token, gespeichert wird sein SHA-256
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Einmal-Challenges für WebAuthn (wenige Minuten gültig)
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- register | login
  data TEXT,                          -- JSON (z. B. Einladung, Nutzer-ID)
  expires_at INTEGER NOT NULL
);
