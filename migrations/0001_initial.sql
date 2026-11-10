CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE google_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  encrypted_key TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  token_hash TEXT UNIQUE NOT NULL,
  cache_seconds INTEGER NOT NULL DEFAULT 0,
  log_bodies INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
) STRICT;

CREATE TABLE quotas (
  project_id TEXT NOT NULL REFERENCES projects(id),
  model TEXT NOT NULL,
  rpm INTEGER,
  tpm INTEGER,
  rpd INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, model)
) STRICT;

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  key_id TEXT REFERENCES google_keys(id),
  model TEXT NOT NULL,
  action TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  input_tokens INTEGER,
  total_tokens INTEGER,
  request_body TEXT,
  response_body TEXT,
  body_state TEXT
) STRICT;
CREATE INDEX requests_time ON requests(started_at DESC, id DESC);
CREATE INDEX requests_project_model_time ON requests(project_id, model, started_at);
CREATE INDEX google_keys_project ON google_keys(project_id, created_at DESC);

CREATE TABLE response_cache (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX response_cache_expiry ON response_cache(expires_at);

CREATE INDEX requests_payload_expiry ON requests(started_at)
  WHERE request_body IS NOT NULL OR response_body IS NOT NULL;
