const { getPool } = require('../db/pool');

async function canUploadToResource({ workspaceId, projectId, taskId, actorId }) {
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM projects AS project
     JOIN workspace_members AS actor ON actor.workspace_id = project.workspace_id AND actor.user_id = $4
     WHERE project.workspace_id = $1 AND project.id = $2
       AND ($3::uuid IS NULL OR EXISTS (
         SELECT 1 FROM tasks AS task
         WHERE task.workspace_id = project.workspace_id AND task.project_id = project.id AND task.id = $3
       ))`,
    [workspaceId, projectId, taskId, actorId],
  );
  return rowCount === 1;
}

async function canRetryFileUpload({ workspaceId, projectId, taskId, fileId, actorId }) {
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM workspace_files AS file
     JOIN workspace_members AS actor ON actor.workspace_id = file.workspace_id AND actor.user_id = $5
     WHERE file.workspace_id = $1 AND file.project_id = $2
       AND file.task_id IS NOT DISTINCT FROM $3::uuid AND file.id = $4
       AND file.uploaded_by = $5 AND file.status IN ('pending', 'failed')`,
    [workspaceId, projectId, taskId, fileId, actorId],
  );
  return rowCount === 1;
}

async function canDeleteFile({ workspaceId, projectId, taskId, fileId, actorId }) {
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM workspace_files AS file
     JOIN workspace_members AS actor ON actor.workspace_id = file.workspace_id AND actor.user_id = $5
     WHERE file.workspace_id = $1 AND file.project_id = $2
       AND file.task_id IS NOT DISTINCT FROM $3::uuid AND file.id = $4
       AND file.status IN ('available', 'pending', 'failed', 'deleting')
       AND (actor.role IN ('owner', 'admin') OR file.uploaded_by = $5)`,
    [workspaceId, projectId, taskId, fileId, actorId],
  );
  return rowCount === 1;
}

async function createPendingFile({
  id, uploadToken, workspaceId, projectId, taskId, actorId, objectKey, originalName, contentType, sizeBytes,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO workspace_files
       (id, workspace_id, project_id, task_id, uploaded_by, object_key, original_name, content_type, size_bytes, upload_token)
     SELECT $1, project.workspace_id, project.id, $4, $5, $6, $7, $8, $9, $10
     FROM projects AS project
     JOIN workspace_members AS actor ON actor.workspace_id = project.workspace_id AND actor.user_id = $5
     WHERE project.workspace_id = $2 AND project.id = $3
       AND ($4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM tasks AS task
         WHERE task.workspace_id = project.workspace_id AND task.project_id = project.id AND task.id = $4
       ))
     RETURNING id, workspace_id AS "workspaceId", project_id AS "projectId", task_id AS "taskId",
               uploaded_by AS "uploadedBy", object_key AS "objectKey", original_name AS "originalName",
               content_type AS "contentType", size_bytes AS "sizeBytes", status,
               upload_token AS "uploadToken", created_at AS "createdAt"`,
    [id, workspaceId, projectId, taskId, actorId, objectKey, originalName, contentType, sizeBytes, uploadToken],
  );
  return rows[0] ?? null;
}

async function prepareFileRetry({ workspaceId, projectId, taskId, fileId, actorId, uploadToken, objectKey }) {
  const { rows } = await getPool().query(
    `WITH candidate AS (
       SELECT file.id, file.object_key
       FROM workspace_files AS file
       WHERE file.workspace_id = $1 AND file.project_id = $2
         AND file.task_id IS NOT DISTINCT FROM $3::uuid AND file.id = $4
         AND file.uploaded_by = $5
         AND (file.status = 'failed' OR (file.status = 'pending' AND file.updated_at <= NOW() - INTERVAL '5 minutes'))
         AND EXISTS (
           SELECT 1 FROM workspace_members AS actor
           WHERE actor.workspace_id = file.workspace_id AND actor.user_id = $5
         )
       FOR UPDATE
     ), updated AS (
       UPDATE workspace_files AS file
       SET status = 'pending', upload_token = $6, object_key = $7, updated_at = NOW()
       FROM candidate
       WHERE file.id = candidate.id
       RETURNING file.id, file.workspace_id, file.project_id, file.task_id, file.uploaded_by,
                 file.object_key, file.original_name, file.content_type, file.size_bytes,
                 file.status, file.upload_token, file.created_at, candidate.object_key AS previous_object_key
     )
     SELECT updated.id, updated.workspace_id AS "workspaceId", updated.project_id AS "projectId",
               updated.task_id AS "taskId", updated.uploaded_by AS "uploadedBy", updated.object_key AS "objectKey",
               updated.previous_object_key AS "previousObjectKey",
               updated.original_name AS "originalName", updated.content_type AS "contentType",
               updated.size_bytes AS "sizeBytes", updated.status, updated.upload_token AS "uploadToken",
               updated.created_at AS "createdAt"
     FROM updated`,
    [workspaceId, projectId, taskId, fileId, actorId, uploadToken, objectKey],
  );
  return rows[0] ?? null;
}

async function markFileAvailable({ workspaceId, fileId, uploadToken }) {
  const { rows } = await getPool().query(
    `UPDATE workspace_files SET status = 'available', upload_token = NULL, updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND upload_token = $3 AND status = 'pending'
     RETURNING id, workspace_id AS "workspaceId", project_id AS "projectId", task_id AS "taskId",
               uploaded_by AS "uploadedBy", original_name AS "originalName",
               content_type AS "contentType", size_bytes AS "sizeBytes", status, created_at AS "createdAt"`,
    [workspaceId, fileId, uploadToken],
  );
  return rows[0] ?? null;
}

async function renewPendingFileUpload({ workspaceId, fileId, uploadToken }) {
  const { rowCount } = await getPool().query(
    `UPDATE workspace_files SET updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND upload_token = $3 AND status = 'pending'`,
    [workspaceId, fileId, uploadToken],
  );
  return rowCount === 1;
}

async function markFileFailed({ workspaceId, fileId, uploadToken }) {
  const { rowCount } = await getPool().query(
    `UPDATE workspace_files SET status = 'failed', upload_token = NULL, updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND upload_token = $3 AND status = 'pending'`,
    [workspaceId, fileId, uploadToken],
  );
  return rowCount === 1;
}

async function listFilesForMember({ workspaceId, projectId, taskId, actorId }) {
  const { rows } = await getPool().query(
    `SELECT actor.user_id AS "authorizedUserId",
            project.id AS "authorizedProjectId",
            file.id, file.workspace_id AS "workspaceId", file.project_id AS "projectId",
            file.task_id AS "taskId", file.uploaded_by AS "uploadedBy",
            file.original_name AS "originalName", file.content_type AS "contentType",
            file.size_bytes AS "sizeBytes", file.created_at AS "createdAt"
     FROM workspace_members AS actor
     JOIN projects AS project ON project.workspace_id = actor.workspace_id AND project.id = $2
     LEFT JOIN tasks AS task ON task.workspace_id = project.workspace_id
       AND task.project_id = project.id AND task.id IS NOT DISTINCT FROM $3::uuid
     LEFT JOIN workspace_files AS file ON file.workspace_id = project.workspace_id
       AND file.project_id = project.id AND file.task_id IS NOT DISTINCT FROM $3::uuid AND file.status = 'available'
     WHERE actor.workspace_id = $1 AND actor.user_id = $4
       AND ($3::uuid IS NULL OR task.id IS NOT NULL)
     ORDER BY file.created_at, file.id`,
    [workspaceId, projectId, taskId, actorId],
  );
  return {
    authorized: rows.length > 0 && rows[0].authorizedProjectId !== null,
    files: rows.filter((row) => row.id !== null)
      .map(({ authorizedUserId: _authorizedUserId, authorizedProjectId: _authorizedProjectId, ...file }) => file),
  };
}

async function getFileForMember({ workspaceId, projectId, taskId, fileId, actorId }) {
  const { rows } = await getPool().query(
    `SELECT file.id, file.workspace_id AS "workspaceId", file.project_id AS "projectId",
            file.task_id AS "taskId", file.object_key AS "objectKey", file.uploaded_by AS "uploadedBy",
            file.original_name AS "originalName", file.content_type AS "contentType",
            file.size_bytes AS "sizeBytes", file.created_at AS "createdAt"
     FROM workspace_files AS file
     JOIN workspace_members AS actor ON actor.workspace_id = file.workspace_id AND actor.user_id = $5
     WHERE file.workspace_id = $1 AND file.project_id = $2
       AND file.task_id IS NOT DISTINCT FROM $3::uuid AND file.id = $4 AND file.status = 'available'
     LIMIT 1`,
    [workspaceId, projectId, taskId, fileId, actorId],
  );
  return rows[0] ?? null;
}

async function beginFileDelete({ workspaceId, projectId, taskId, fileId, actorId }) {
  const { rows } = await getPool().query(
    `UPDATE workspace_files AS file
     SET status = 'deleting', upload_token = NULL, updated_at = NOW()
     WHERE file.workspace_id = $1 AND file.project_id = $2
       AND file.task_id IS NOT DISTINCT FROM $3::uuid AND file.id = $4
       AND file.status IN ('available', 'failed', 'deleting')
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = file.workspace_id AND actor.user_id = $5
           AND (actor.role IN ('owner', 'admin') OR file.uploaded_by = $5)
       )
     RETURNING file.id, file.workspace_id AS "workspaceId", file.object_key AS "objectKey"`,
    [workspaceId, projectId, taskId, fileId, actorId],
  );
  return rows[0] ?? null;
}

async function finishFileDelete({ workspaceId, fileId }) {
  const { rowCount } = await getPool().query(
    `DELETE FROM workspace_files WHERE workspace_id = $1 AND id = $2 AND status = 'deleting'`,
    [workspaceId, fileId],
  );
  return rowCount === 1;
}

async function restoreFileAfterDeleteFailure({ workspaceId, fileId }) {
  const { rowCount } = await getPool().query(
    `UPDATE workspace_files SET status = 'failed', updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND status = 'deleting'`,
    [workspaceId, fileId],
  );
  return rowCount === 1;
}

module.exports = {
  beginFileDelete,
  canDeleteFile,
  canRetryFileUpload,
  canUploadToResource,
  createPendingFile,
  finishFileDelete,
  getFileForMember,
  listFilesForMember,
  markFileAvailable,
  markFileFailed,
  prepareFileRetry,
  renewPendingFileUpload,
  restoreFileAfterDeleteFailure,
};
