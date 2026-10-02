-- Timestamps are unix milliseconds. Secrets are stored only as SHA-256 hex.
-- D1 enforces foreign keys, so deleting an account cascades to everything.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_account ON identities(account_id);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'host')),
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  node_id TEXT NOT NULL,
  host_credential_hash TEXT UNIQUE,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, node_id)
);

CREATE TABLE claims (
  code TEXT PRIMARY KEY,
  host_secret_hash TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE email_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Server-issued Apple nonces (hashed), consumed once by /auth/apple.
CREATE TABLE nonces (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- sha256 of accepted Google ID tokens, kept until they expire (replay guard).
CREATE TABLE used_tokens (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
