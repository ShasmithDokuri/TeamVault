BEGIN;

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (name = BTRIM(name) AND LENGTH(name) BETWEEN 1 AND 100),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner_idx
  ON workspace_members (workspace_id)
  WHERE role = 'owner';

CREATE INDEX IF NOT EXISTS workspace_members_by_user_idx
  ON workspace_members (user_id, workspace_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT workspaces.id
    FROM workspaces
    LEFT JOIN workspace_members ON workspace_members.workspace_id = workspaces.id
    GROUP BY workspaces.id
    HAVING COUNT(workspace_members.user_id) FILTER (WHERE workspace_members.role = 'owner') <> 1
  ) THEN
    RAISE EXCEPTION 'Existing workspaces must have exactly one owner before this migration can complete.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_workspace_owner_invariant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  workspace_id_to_check UUID;
  owner_count INTEGER;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM workspaces) THEN
      RAISE EXCEPTION 'Workspace memberships cannot be truncated while workspaces exist.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'workspaces' THEN
    workspace_id_to_check := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    workspace_id_to_check := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  END IF;

  IF EXISTS (SELECT 1 FROM workspaces WHERE id = workspace_id_to_check) THEN
    SELECT COUNT(*) INTO owner_count
    FROM workspace_members
    WHERE workspace_id = workspace_id_to_check AND role = 'owner';

    IF owner_count <> 1 THEN
      RAISE EXCEPTION 'A workspace must have exactly one owner.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'workspaces_require_owner'
      AND tgrelid = 'workspaces'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE CONSTRAINT TRIGGER workspaces_require_owner
      AFTER INSERT ON workspaces
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_workspace_owner_invariant();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'workspace_members_require_owner'
      AND tgrelid = 'workspace_members'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE CONSTRAINT TRIGGER workspace_members_require_owner
      AFTER INSERT OR UPDATE OR DELETE ON workspace_members
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_workspace_owner_invariant();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'workspace_members_truncate_require_owner'
      AND tgrelid = 'workspace_members'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER workspace_members_truncate_require_owner
      AFTER TRUNCATE ON workspace_members
      FOR EACH STATEMENT EXECUTE FUNCTION enforce_workspace_owner_invariant();
  END IF;
END;
$$;

COMMIT;
