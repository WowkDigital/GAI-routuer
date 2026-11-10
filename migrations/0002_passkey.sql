CREATE TABLE admin_passkey (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE admin_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_challenges_expiry ON admin_challenges(expires_at);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
