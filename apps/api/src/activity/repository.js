const { getPool } = require('../db/pool');

async function recordActivity(client, {
  workspaceId, actorId, eventType, entityType, entityId,
  projectId = null, taskId = null, commentId = null, metadata = {},
}) {
  await client.query(
    `INSERT INTO activity_events
       (workspace_id, actor_id, event_type, entity_type, entity_id, project_id, task_id, comment_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [workspaceId, actorId, eventType, entityType, entityId, projectId, taskId, commentId, JSON.stringify(metadata)],
  );
}

async function listActivityForMember({ workspaceId, actorId, limit, before }) {
  const { rows } = await getPool().query(
    `SELECT actor.user_id AS "authorizedUserId",
            event.id::text AS id, event.workspace_id AS "workspaceId",
            event.actor_id AS "actorId", event.event_type AS "eventType",
            event.entity_type AS "entityType", event.entity_id AS "entityId",
            event.project_id AS "projectId", event.task_id AS "taskId",
            event.comment_id AS "commentId", event.metadata,
            event.created_at AS "createdAt"
     FROM workspace_members AS actor
     LEFT JOIN activity_events AS event ON event.workspace_id = actor.workspace_id
       AND ($3::bigint IS NULL OR event.id < $3::bigint)
     WHERE actor.workspace_id = $1 AND actor.user_id = $2
     ORDER BY event.id DESC
     LIMIT $4`,
    [workspaceId, actorId, before, limit],
  );
  return {
    authorized: rows.length > 0,
    events: rows.filter((row) => row.id !== null)
      .map(({ authorizedUserId: _authorizedUserId, ...event }) => event),
  };
}

module.exports = { listActivityForMember, recordActivity };
