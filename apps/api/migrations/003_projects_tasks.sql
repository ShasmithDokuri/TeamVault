BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (
    name = BTRIM(name) AND LENGTH(name) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'
  ),
  description TEXT CHECK (description IS NULL OR LENGTH(description) <= 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT projects_workspace_id_id_unique UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS projects_by_workspace_created_idx
  ON projects (workspace_id, created_at, id);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  project_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (
    title = BTRIM(title) AND LENGTH(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'
  ),
  description TEXT CHECK (description IS NULL OR LENGTH(description) <= 10000),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_id UUID,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_date DATE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tasks_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT tasks_assignee_workspace_member_fk
    FOREIGN KEY (workspace_id, assignee_id)
    REFERENCES workspace_members (workspace_id, user_id)
    ON DELETE SET NULL (assignee_id)
);

CREATE INDEX IF NOT EXISTS tasks_by_project_created_idx
  ON tasks (workspace_id, project_id, created_at, id);

CREATE INDEX IF NOT EXISTS tasks_by_assignee_idx
  ON tasks (workspace_id, assignee_id)
  WHERE assignee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_by_workspace_status_idx
  ON tasks (workspace_id, status, priority);

COMMIT;
