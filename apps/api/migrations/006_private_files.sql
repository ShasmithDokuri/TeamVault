BEGIN;

CREATE TABLE IF NOT EXISTS workspace_files (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_id UUID,
  uploaded_by UUID,
  object_key TEXT NOT NULL UNIQUE CHECK (object_key !~ '[[:cntrl:]]'),
  original_name TEXT NOT NULL CHECK (
    original_name = BTRIM(original_name)
    AND LENGTH(original_name) BETWEEN 1 AND 255
    AND original_name !~ '[[:cntrl:]/]'
    AND STRPOS(original_name, CHR(92)) = 0
  ),
  content_type TEXT NOT NULL CHECK (content_type IN (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
  )),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'failed', 'deleting')),
  upload_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_files_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT workspace_files_uploader_workspace_member_fk
    FOREIGN KEY (workspace_id, uploaded_by)
    REFERENCES workspace_members (workspace_id, user_id) ON DELETE SET NULL (uploaded_by),
  CONSTRAINT workspace_files_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_files_task_project_workspace_fk
    FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT workspace_files_upload_token_state_check
    CHECK ((status = 'pending') = (upload_token IS NOT NULL))
);

ALTER TABLE workspace_files ADD COLUMN IF NOT EXISTS upload_token UUID;

UPDATE workspace_files
SET upload_token = gen_random_uuid(), updated_at = NOW() - INTERVAL '5 minutes'
WHERE status = 'pending' AND upload_token IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_files_upload_token_state_check'
      AND conrelid = 'workspace_files'::regclass
  ) THEN
    ALTER TABLE workspace_files
      ADD CONSTRAINT workspace_files_upload_token_state_check
      CHECK ((status = 'pending') = (upload_token IS NOT NULL));
  END IF;
END;
$$;

DO $$
DECLARE
  constraint_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_definition
  FROM pg_constraint
  WHERE conname = 'workspace_files_uploader_workspace_member_fk'
    AND conrelid = 'workspace_files'::regclass;
  IF constraint_definition IS NULL THEN
    ALTER TABLE workspace_files
      ADD CONSTRAINT workspace_files_uploader_workspace_member_fk
      FOREIGN KEY (workspace_id, uploaded_by)
      REFERENCES workspace_members (workspace_id, user_id) ON DELETE SET NULL (uploaded_by);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO constraint_definition
  FROM pg_constraint
  WHERE conname = 'workspace_files_project_workspace_fk'
    AND conrelid = 'workspace_files'::regclass;
  IF constraint_definition IS NOT NULL AND POSITION('ON DELETE RESTRICT' IN constraint_definition) = 0 THEN
    ALTER TABLE workspace_files DROP CONSTRAINT workspace_files_project_workspace_fk;
    ALTER TABLE workspace_files
      ADD CONSTRAINT workspace_files_project_workspace_fk
      FOREIGN KEY (workspace_id, project_id)
      REFERENCES projects (workspace_id, id) ON DELETE RESTRICT;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO constraint_definition
  FROM pg_constraint
  WHERE conname = 'workspace_files_task_project_workspace_fk'
    AND conrelid = 'workspace_files'::regclass;
  IF constraint_definition IS NOT NULL AND POSITION('ON DELETE RESTRICT' IN constraint_definition) = 0 THEN
    ALTER TABLE workspace_files DROP CONSTRAINT workspace_files_task_project_workspace_fk;
    ALTER TABLE workspace_files
      ADD CONSTRAINT workspace_files_task_project_workspace_fk
      FOREIGN KEY (workspace_id, project_id, task_id)
      REFERENCES tasks (workspace_id, project_id, id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS workspace_files_by_project_idx
  ON workspace_files (workspace_id, project_id, created_at, id)
  WHERE status = 'available';

CREATE INDEX IF NOT EXISTS workspace_files_by_task_idx
  ON workspace_files (workspace_id, project_id, task_id, created_at, id)
  WHERE task_id IS NOT NULL AND status = 'available';

CREATE INDEX IF NOT EXISTS workspace_files_pending_idx
  ON workspace_files (updated_at)
  WHERE status IN ('pending', 'failed', 'deleting');

COMMIT;
