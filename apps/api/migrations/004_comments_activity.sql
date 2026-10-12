BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_workspace_project_id_unique'
      AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_workspace_project_id_unique UNIQUE (workspace_id, project_id, id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_id UUID,
  author_id UUID,
  content TEXT NOT NULL CHECK (
    content = BTRIM(content) AND LENGTH(content) BETWEEN 1 AND 5000
      AND content !~ '[[:cntrl:]]'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comments_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT comments_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT comments_task_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT comments_author_workspace_member_fk
    FOREIGN KEY (workspace_id, author_id)
    REFERENCES workspace_members (workspace_id, user_id)
    ON DELETE SET NULL (author_id)
);

CREATE INDEX IF NOT EXISTS comments_by_project_created_idx
  ON comments (workspace_id, project_id, created_at, id);

CREATE INDEX IF NOT EXISTS comments_by_task_created_idx
  ON comments (workspace_id, project_id, task_id, created_at, id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS comments_by_author_idx
  ON comments (workspace_id, author_id)
  WHERE author_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS activity_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'project_created', 'project_updated', 'project_deleted',
    'task_created', 'task_updated', 'task_assigned', 'task_deleted',
    'comment_created', 'comment_updated', 'comment_deleted'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'task', 'comment')),
  entity_id UUID NOT NULL,
  project_id UUID,
  task_id UUID,
  comment_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activity_entity_type_matches_event CHECK (
    (event_type LIKE 'project_%' AND entity_type = 'project') OR
    (event_type LIKE 'task_%' AND entity_type = 'task') OR
    (event_type LIKE 'comment_%' AND entity_type = 'comment')
  ),
  CONSTRAINT activity_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE SET NULL (project_id),
  CONSTRAINT activity_task_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id)
    ON DELETE SET NULL (task_id),
  CONSTRAINT activity_comment_workspace_fk
    FOREIGN KEY (workspace_id, comment_id)
    REFERENCES comments (workspace_id, id) ON DELETE SET NULL (comment_id)
);

DO $$
DECLARE
  task_activity_fk_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'activity_entity_type_matches_event'
      AND conrelid = 'activity_events'::regclass
  ) THEN
    ALTER TABLE activity_events
      ADD CONSTRAINT activity_entity_type_matches_event CHECK (
        (event_type LIKE 'project_%' AND entity_type = 'project') OR
        (event_type LIKE 'task_%' AND entity_type = 'task') OR
        (event_type LIKE 'comment_%' AND entity_type = 'comment')
      );
  END IF;

  SELECT pg_get_constraintdef(oid) INTO task_activity_fk_definition
  FROM pg_constraint
  WHERE conname = 'activity_task_project_workspace_fk'
    AND conrelid = 'activity_events'::regclass;
  IF task_activity_fk_definition IS NULL THEN
    ALTER TABLE activity_events
      ADD CONSTRAINT activity_task_project_workspace_fk
      FOREIGN KEY (workspace_id, project_id, task_id)
      REFERENCES tasks (workspace_id, project_id, id)
      ON DELETE SET NULL (task_id);
  ELSIF POSITION('ON DELETE SET NULL (task_id)' IN task_activity_fk_definition) = 0 THEN
    ALTER TABLE activity_events DROP CONSTRAINT activity_task_project_workspace_fk;
    ALTER TABLE activity_events
      ADD CONSTRAINT activity_task_project_workspace_fk
      FOREIGN KEY (workspace_id, project_id, task_id)
      REFERENCES tasks (workspace_id, project_id, id)
      ON DELETE SET NULL (task_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS activity_by_workspace_recent_idx
  ON activity_events (workspace_id, id DESC);

CREATE INDEX IF NOT EXISTS activity_by_workspace_entity_idx
  ON activity_events (workspace_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS activity_by_project_idx
  ON activity_events (workspace_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS activity_by_task_idx
  ON activity_events (workspace_id, project_id, task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS activity_by_comment_idx
  ON activity_events (workspace_id, comment_id)
  WHERE comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS activity_by_actor_idx
  ON activity_events (actor_id)
  WHERE actor_id IS NOT NULL;

COMMIT;
