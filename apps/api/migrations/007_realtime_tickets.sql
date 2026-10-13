BEGIN;

CREATE TABLE IF NOT EXISTS realtime_tickets (
  ticket_hash CHAR(64) PRIMARY KEY,
  session_token_hash CHAR(64) NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS realtime_tickets_expiry_idx ON realtime_tickets (expires_at);

COMMIT;
