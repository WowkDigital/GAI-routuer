CREATE TABLE config_token (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
