const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');

async function createProject({ workspaceId, actorId, name, description }) {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO projects (id, workspace_id, name, description)
       SELECT $3, workspace.id, $4, $5
       FROM workspaces AS workspace
       JOIN workspace_members AS actor ON actor.workspace_id = workspace.id
       WHERE workspace.id = $1 AND actor.user_id = $2
         AND actor.role IN ('owner', 'admin')
       RETURNING id, workspace_id AS "workspaceId", name, description,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [workspaceId, actorId, randomUUID(), name, description],
    );
    return rows[0] ?? null;
  } catch (error) {
    if (error.code === '23503') return null;
    throw error;
  }
}

async function listProjectsForMember({ workspaceId, actorId }) {
  const { rows } = await getPool().query(
    `SELECT actor.user_id AS "authorizedUserId",
            project.id, project.workspace_id AS "workspaceId", project.name, project.description,
            project.created_at AS "createdAt", project.updated_at AS "updatedAt"
     FROM workspace_members AS actor
     LEFT JOIN projects AS project ON project.workspace_id = actor.workspace_id
     WHERE actor.workspace_id = $1 AND actor.user_id = $2
     ORDER BY project.created_at, project.id`,
    [workspaceId, actorId],
  );
  return {
    authorized: rows.length > 0,
    projects: rows.filter((row) => row.id !== null).map(({ authorizedUserId: _authorizedUserId, ...project }) => project),
  };
}

async function getProjectForMember({ workspaceId, projectId, actorId }) {
  const { rows } = await getPool().query(
    `SELECT project.id, project.workspace_id AS "workspaceId", project.name, project.description,
            project.created_at AS "createdAt", project.updated_at AS "updatedAt"
     FROM projects AS project
     JOIN workspace_members AS actor ON actor.workspace_id = project.workspace_id
     WHERE project.workspace_id = $1 AND project.id = $2 AND actor.user_id = $3
     LIMIT 1`,
    [workspaceId, projectId, actorId],
  );
  return rows[0] ?? null;
}

async function updateProjectForManager({ workspaceId, projectId, actorId, name, description }) {
  const { rows } = await getPool().query(
    `UPDATE projects AS target
     SET name = CASE WHEN $4::boolean THEN $5::text ELSE target.name END,
         description = CASE WHEN $6::boolean THEN $7::text ELSE target.description END,
         updated_at = NOW()
     WHERE target.workspace_id = $1 AND target.id = $2
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.workspace_id AND actor.user_id = $3
           AND actor.role IN ('owner', 'admin')
       )
     RETURNING target.id, target.workspace_id AS "workspaceId", target.name, target.description,
               target.created_at AS "createdAt", target.updated_at AS "updatedAt"`,
    [workspaceId, projectId, actorId, name.provided, name.value, description.provided, description.value],
  );
  return rows[0] ?? null;
}

async function deleteProjectForManager({ workspaceId, projectId, actorId }) {
  const { rows } = await getPool().query(
    `DELETE FROM projects AS target
     WHERE target.workspace_id = $1 AND target.id = $2
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.workspace_id AND actor.user_id = $3
           AND actor.role IN ('owner', 'admin')
       )
     RETURNING target.id`,
    [workspaceId, projectId, actorId],
  );
  return rows.length > 0;
}

async function createTask({ workspaceId, projectId, actorId, task }) {
  return withTransaction(async (client) => {
    const project = await client.query(
      `SELECT target.id
       FROM projects AS target
       JOIN workspace_members AS actor ON actor.workspace_id = target.workspace_id
       WHERE target.workspace_id = $1 AND target.id = $2 AND actor.user_id = $3
       FOR KEY SHARE OF target, actor`,
      [workspaceId, projectId, actorId],
    );
    if (project.rowCount === 0) return { kind: 'not_found' };

    if (task.assigneeId) {
      const assignee = await client.query(
        'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR KEY SHARE',
        [workspaceId, task.assigneeId],
      );
      if (assignee.rowCount === 0) return { kind: 'invalid_assignee' };
    }

    const { rows } = await client.query(
      `INSERT INTO tasks (
         id, workspace_id, project_id, title, description, status, priority,
         assignee_id, created_by, due_date
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, workspace_id AS "workspaceId", project_id AS "projectId", title,
                 description, status, priority, assignee_id AS "assigneeId",
                 created_by AS "createdBy", to_char(due_date, 'YYYY-MM-DD') AS "dueDate", version,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [randomUUID(), workspaceId, projectId, task.title, task.description, task.status,
        task.priority, task.assigneeId, actorId, task.dueDate],
    );
    return { kind: 'created', task: rows[0] };
  });
}

async function listTasksForMember({ workspaceId, projectId, actorId }) {
  const { rows } = await getPool().query(
    `SELECT project.id AS "authorizedProjectId",
            task.id, task.workspace_id AS "workspaceId", task.project_id AS "projectId",
            task.title, task.description, task.status, task.priority,
            task.assignee_id AS "assigneeId", task.created_by AS "createdBy",
            to_char(task.due_date, 'YYYY-MM-DD') AS "dueDate", task.version,
            task.created_at AS "createdAt", task.updated_at AS "updatedAt"
     FROM workspace_members AS actor
     JOIN projects AS project ON project.workspace_id = actor.workspace_id AND project.id = $2
     LEFT JOIN tasks AS task
       ON task.workspace_id = project.workspace_id AND task.project_id = project.id
     WHERE actor.workspace_id = $1 AND actor.user_id = $3
     ORDER BY task.created_at, task.id`,
    [workspaceId, projectId, actorId],
  );
  return {
    authorized: rows.length > 0,
    tasks: rows.filter((row) => row.id !== null).map(({ authorizedProjectId: _authorizedProjectId, ...task }) => task),
  };
}

async function getTaskForMember({ workspaceId, projectId, taskId, actorId }) {
  const { rows } = await getPool().query(
    `SELECT task.id, task.workspace_id AS "workspaceId", task.project_id AS "projectId",
            task.title, task.description, task.status, task.priority,
            task.assignee_id AS "assigneeId", task.created_by AS "createdBy",
            to_char(task.due_date, 'YYYY-MM-DD') AS "dueDate", task.version,
            task.created_at AS "createdAt", task.updated_at AS "updatedAt"
     FROM tasks AS task
     JOIN workspace_members AS actor ON actor.workspace_id = task.workspace_id
     WHERE task.workspace_id = $1 AND task.project_id = $2 AND task.id = $3
       AND actor.user_id = $4
     LIMIT 1`,
    [workspaceId, projectId, taskId, actorId],
  );
  return rows[0] ?? null;
}

async function updateTaskForMember({ workspaceId, projectId, taskId, actorId, expectedVersion, changes }) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT task.id, task.version
       FROM tasks AS task
       JOIN workspace_members AS actor ON actor.workspace_id = task.workspace_id
       WHERE task.workspace_id = $1 AND task.project_id = $2 AND task.id = $3
         AND actor.user_id = $4`,
      [workspaceId, projectId, taskId, actorId],
    );
    if (current.rowCount === 0) return { kind: 'not_found' };
    if (current.rows[0].version !== expectedVersion) return { kind: 'conflict' };

    if (changes.assigneeId.provided && changes.assigneeId.value !== null) {
      const assignee = await client.query(
        'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR KEY SHARE',
        [workspaceId, changes.assigneeId.value],
      );
      if (assignee.rowCount === 0) return { kind: 'invalid_assignee' };
    }

    const locked = await client.query(
      `SELECT task.id, task.version
       FROM tasks AS task
       JOIN workspace_members AS actor ON actor.workspace_id = task.workspace_id
       WHERE task.workspace_id = $1 AND task.project_id = $2 AND task.id = $3
         AND actor.user_id = $4
       FOR UPDATE OF task`,
      [workspaceId, projectId, taskId, actorId],
    );
    if (locked.rowCount === 0) return { kind: 'not_found' };
    if (locked.rows[0].version !== expectedVersion) return { kind: 'conflict' };

    const { rows } = await client.query(
      `UPDATE tasks AS target
       SET title = CASE WHEN $5::boolean THEN $6::text ELSE target.title END,
           description = CASE WHEN $7::boolean THEN $8::text ELSE target.description END,
           status = CASE WHEN $9::boolean THEN $10::text ELSE target.status END,
           priority = CASE WHEN $11::boolean THEN $12::text ELSE target.priority END,
           assignee_id = CASE WHEN $13::boolean THEN $14::uuid ELSE target.assignee_id END,
           due_date = CASE WHEN $15::boolean THEN $16::date ELSE target.due_date END,
           version = target.version + 1,
           updated_at = NOW()
       WHERE target.workspace_id = $1 AND target.project_id = $2 AND target.id = $3
         AND target.version = $4
       RETURNING target.id, target.workspace_id AS "workspaceId", target.project_id AS "projectId",
                 target.title, target.description, target.status, target.priority,
                 target.assignee_id AS "assigneeId", target.created_by AS "createdBy",
                 to_char(target.due_date, 'YYYY-MM-DD') AS "dueDate", target.version,
                 target.created_at AS "createdAt", target.updated_at AS "updatedAt"`,
      [workspaceId, projectId, taskId, expectedVersion,
        changes.title.provided, changes.title.value,
        changes.description.provided, changes.description.value,
        changes.status.provided, changes.status.value,
        changes.priority.provided, changes.priority.value,
        changes.assigneeId.provided, changes.assigneeId.value,
        changes.dueDate.provided, changes.dueDate.value],
    );
    return rows[0] ? { kind: 'updated', task: rows[0] } : { kind: 'conflict' };
  });
}

async function deleteTaskForManager({ workspaceId, projectId, taskId, actorId }) {
  const { rows } = await getPool().query(
    `DELETE FROM tasks AS target
     WHERE target.workspace_id = $1 AND target.project_id = $2 AND target.id = $3
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.workspace_id AND actor.user_id = $4
           AND actor.role IN ('owner', 'admin')
       )
     RETURNING target.id`,
    [workspaceId, projectId, taskId, actorId],
  );
  return rows.length > 0;
}

async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createProject,
  createTask,
  deleteProjectForManager,
  deleteTaskForManager,
  getProjectForMember,
  getTaskForMember,
  listProjectsForMember,
  listTasksForMember,
  updateProjectForManager,
  updateTaskForMember,
};
