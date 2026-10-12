BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT,
  google_subject TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_have_auth_method CHECK (password_hash IS NOT NULL OR google_subject IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS google_oauth_states (
  state_hash CHAR(64) PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS google_oauth_states_expiry_idx ON google_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS auth_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'registration_success',
    'registration_failure',
    'login_success',
    'login_failure',
    'logout',
    'google_login_success',
    'google_login_failure'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_audit_events_created_at_idx ON auth_audit_events (created_at);

COMMIT;
