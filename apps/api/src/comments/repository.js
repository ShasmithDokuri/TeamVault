const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');
const { recordActivity } = require('../projects/repository');

async function createComment({ workspaceId, projectId, taskId = null, actorId, content }) {
  return withTransaction(async (client) => {
    if (!await lockCommentTarget(client, { workspaceId, projectId, taskId, actorId })) return null;

    const commentId = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO comments (id, workspace_id, project_id, task_id, author_id, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, workspace_id AS "workspaceId", project_id AS "projectId",
                 task_id AS "taskId", author_id AS "authorId", content, version,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [commentId, workspaceId, projectId, taskId, actorId, content],
    );
    await recordActivity(client, {
      workspaceId, actorId, eventType: 'comment_created', entityType: 'comment',
      entityId: commentId, projectId, taskId, commentId,
    });
    return rows[0];
  });
}

async function listCommentsForMember({ workspaceId, projectId, taskId = null, actorId }) {
  const { rows } = await getPool().query(
    `SELECT actor.user_id AS "authorizedUserId", comment.id,
            comment.workspace_id AS "workspaceId", comment.project_id AS "projectId",
            comment.task_id AS "taskId", comment.author_id AS "authorId", comment.content,
            comment.version, comment.created_at AS "createdAt", comment.updated_at AS "updatedAt"
     FROM workspace_members AS actor
     JOIN projects AS project ON project.workspace_id = actor.workspace_id AND project.id = $2
     LEFT JOIN tasks AS target_task
       ON target_task.workspace_id = project.workspace_id AND target_task.project_id = project.id
      AND target_task.id = $3
     LEFT JOIN comments AS comment
       ON comment.workspace_id = project.workspace_id AND comment.project_id = project.id
      AND comment.task_id IS NOT DISTINCT FROM $3::uuid
     WHERE actor.workspace_id = $1 AND actor.user_id = $4
       AND ($3::uuid IS NULL OR target_task.id IS NOT NULL)
     ORDER BY comment.created_at, comment.id`,
    [workspaceId, projectId, taskId, actorId],
  );
  return {
    authorized: rows.length > 0,
    comments: rows.filter((row) => row.id !== null)
      .map(({ authorizedUserId: _authorizedUserId, ...comment }) => comment),
  };
}

async function updateComment({ workspaceId, projectId, taskId = null, commentId, actorId, version, content }) {
  return withTransaction(async (client) => {
    if (!await lockCommentTarget(client, { workspaceId, projectId, taskId, actorId })) {
      return { kind: 'not_found' };
    }
    const { rows } = await client.query(
      `UPDATE comments AS target
       SET content = $7, version = target.version + 1, updated_at = NOW()
       WHERE target.workspace_id = $1 AND target.project_id = $2
         AND target.task_id IS NOT DISTINCT FROM $3::uuid AND target.id = $4
         AND target.version = $5 AND target.author_id = $6
         AND EXISTS (
           SELECT 1 FROM workspace_members AS actor
           WHERE actor.workspace_id = target.workspace_id AND actor.user_id = $6
         )
       RETURNING target.id, target.workspace_id AS "workspaceId",
                 target.project_id AS "projectId", target.task_id AS "taskId",
                 target.author_id AS "authorId", target.content, target.version,
                 target.created_at AS "createdAt", target.updated_at AS "updatedAt"`,
      [workspaceId, projectId, taskId, commentId, version, actorId, content],
    );
    if (!rows[0]) {
      const exists = await client.query(
        `SELECT 1 FROM comments AS target JOIN workspace_members AS actor
           ON actor.workspace_id = target.workspace_id AND actor.user_id = $5
         WHERE target.workspace_id = $1 AND target.project_id = $2
           AND target.task_id IS NOT DISTINCT FROM $3::uuid AND target.id = $4
           AND target.author_id = $5`,
        [workspaceId, projectId, taskId, commentId, actorId],
      );
      return exists.rowCount ? { kind: 'conflict' } : { kind: 'not_found' };
    }
    await recordActivity(client, {
      workspaceId, actorId, eventType: 'comment_updated', entityType: 'comment',
      entityId: commentId, projectId, taskId, commentId,
    });
    return { kind: 'updated', comment: rows[0] };
  });
}

async function deleteComment({ workspaceId, projectId, taskId = null, commentId, actorId }) {
  return withTransaction(async (client) => {
    if (!await lockCommentTarget(client, { workspaceId, projectId, taskId, actorId })) return false;
    const { rows } = await client.query(
      `DELETE FROM comments AS target
       WHERE target.workspace_id = $1 AND target.project_id = $2
         AND target.task_id IS NOT DISTINCT FROM $3::uuid AND target.id = $4
         AND EXISTS (
           SELECT 1 FROM workspace_members AS actor
           WHERE actor.workspace_id = target.workspace_id AND actor.user_id = $5
             AND (target.author_id = actor.user_id OR actor.role IN ('owner', 'admin'))
         )
       RETURNING target.id`,
      [workspaceId, projectId, taskId, commentId, actorId],
    );
    if (!rows[0]) return false;
    await recordActivity(client, {
      workspaceId, actorId, eventType: 'comment_deleted', entityType: 'comment',
      entityId: commentId, projectId, taskId,
    });
    return true;
  });
}

async function lockCommentTarget(client, { workspaceId, projectId, taskId, actorId }) {
  const workspace = await client.query(
    'SELECT id FROM workspaces WHERE id = $1 FOR KEY SHARE',
    [workspaceId],
  );
  if (workspace.rowCount === 0) return false;
  const project = await client.query(
    `SELECT project.id
     FROM projects AS project
     JOIN workspace_members AS actor ON actor.workspace_id = project.workspace_id
     WHERE project.workspace_id = $1 AND project.id = $2 AND actor.user_id = $3
     FOR KEY SHARE OF project, actor`,
    [workspaceId, projectId, actorId],
  );
  if (project.rowCount === 0) return false;
  if (taskId === null) return true;
  const task = await client.query(
    `SELECT id FROM tasks
     WHERE workspace_id = $1 AND project_id = $2 AND id = $3
     FOR KEY SHARE`,
    [workspaceId, projectId, taskId],
  );
  return task.rowCount > 0;
}

async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Keep the original error. */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createComment, deleteComment, listCommentsForMember, updateComment };
