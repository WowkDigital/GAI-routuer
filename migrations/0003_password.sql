ALTER TABLE admin_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'passkey'
  CHECK (auth_method IN ('passkey', 'password'));

CREATE TABLE admin_password (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  salt TEXT NOT NULL,
  verifier TEXT NOT NULL
) STRICT;
