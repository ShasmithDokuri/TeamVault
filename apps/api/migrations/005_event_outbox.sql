BEGIN;

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'project_created', 'project_updated', 'project_deleted',
    'task_created', 'task_updated', 'task_assigned', 'task_deleted',
    'comment_created', 'comment_updated', 'comment_deleted'
  )),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IN (
    'broker_unavailable', 'publish_rejected', 'database_unavailable', 'unknown'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (published_at IS NULL OR dead_lettered_at IS NULL)
);

CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
  ON outbox_events (available_at, created_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_events_workspace_idx
  ON outbox_events (workspace_id, created_at DESC);

COMMIT;
