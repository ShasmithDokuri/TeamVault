const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');

async function createWorkspaceForUser({ userId, name }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, created_at, updated_at',
      [randomUUID(), name, userId],
    );
    const workspace = rows[0];
    await client.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspace.id, userId, 'owner'],
    );
    return { ...workspace, role: 'owner' };
  });
}

async function listWorkspacesForUser(userId) {
  const { rows } = await getPool().query(
    `SELECT workspaces.id, workspaces.name, workspaces.created_at, workspaces.updated_at, workspace_members.role
     FROM workspaces
     JOIN workspace_members ON workspace_members.workspace_id = workspaces.id
     WHERE workspace_members.user_id = $1
     ORDER BY workspaces.created_at, workspaces.id`,
    [userId],
  );
  return rows;
}

async function getWorkspaceForMember({ workspaceId, userId }) {
  const { rows } = await getPool().query(
    `SELECT workspaces.id, workspaces.name, workspaces.created_at, workspaces.updated_at, requester.role
     FROM workspaces
     JOIN workspace_members AS requester ON requester.workspace_id = workspaces.id
     WHERE workspaces.id = $1 AND requester.user_id = $2
     LIMIT 1`,
    [workspaceId, userId],
  );
  return rows[0] ?? null;
}

async function updateWorkspaceForManager({ workspaceId, userId, name }) {
  const { rows } = await getPool().query(
    `UPDATE workspaces AS target
     SET name = $3, updated_at = NOW()
     WHERE target.id = $1
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.id
           AND actor.user_id = $2
           AND actor.role IN ('owner', 'admin')
       )
     RETURNING target.id, target.name, target.created_at, target.updated_at`,
    [workspaceId, userId, name],
  );
  return rows[0] ?? null;
}

async function deleteWorkspaceForOwner({ workspaceId, userId }) {
  const { rows } = await getPool().query(
    `DELETE FROM workspaces AS target
     WHERE target.id = $1
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.id
           AND actor.user_id = $2
           AND actor.role = 'owner'
       )
     RETURNING target.id`,
    [workspaceId, userId],
  );
  return rows.length > 0;
}

async function listMembersForMember({ workspaceId, userId }) {
  const { rows } = await getPool().query(
    `SELECT target.user_id, users.email, users.display_name, target.role, target.created_at
     FROM workspace_members AS requester
     JOIN workspace_members AS target ON target.workspace_id = requester.workspace_id
     JOIN users ON users.id = target.user_id
     WHERE requester.workspace_id = $1 AND requester.user_id = $2
     ORDER BY CASE target.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
              users.email`,
    [workspaceId, userId],
  );
  return rows;
}

async function addMemberForManager({ workspaceId, actorId, userId = null, email = null, role }) {
  const { rows } = await getPool().query(
    `WITH authorized_actor AS (
       SELECT workspace_id, role
       FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2
         AND (role = 'owner' OR (role = 'admin' AND $4 = 'member'))
     ), added AS (
       INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT authorized_actor.workspace_id, target.id, $4
       FROM authorized_actor
       JOIN users AS target ON (
         ($3::uuid IS NOT NULL AND target.id = $3::uuid)
         OR ($5::text IS NOT NULL AND target.email = $5::text)
       )
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING workspace_id, user_id, role, created_at
     )
     SELECT added.user_id, users.email, users.display_name, added.role, added.created_at
     FROM added JOIN users ON users.id = added.user_id`,
    [workspaceId, actorId, userId, role, email],
  );
  return rows[0] ?? null;
}

async function updateMemberRoleForOwner({ workspaceId, actorId, userId, role }) {
  const { rows } = await getPool().query(
    `UPDATE workspace_members AS target
     SET role = $4
     FROM users
     WHERE target.workspace_id = $1 AND target.user_id = $3 AND target.role <> 'owner'
       AND users.id = target.user_id
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.workspace_id
           AND actor.user_id = $2 AND actor.role = 'owner'
       )
     RETURNING target.user_id, users.email, users.display_name, target.role, target.created_at`,
    [workspaceId, actorId, userId, role],
  );
  return rows[0] ?? null;
}

async function removeMemberForManager({ workspaceId, actorId, userId }) {
  const { rows } = await getPool().query(
    `DELETE FROM workspace_members AS target
     WHERE target.workspace_id = $1 AND target.user_id = $3 AND target.role <> 'owner'
       AND EXISTS (
         SELECT 1 FROM workspace_members AS actor
         WHERE actor.workspace_id = target.workspace_id AND actor.user_id = $2
           AND actor.role IN ('owner', 'admin')
           AND (actor.role = 'owner' OR target.role = 'member')
       )
     RETURNING target.user_id`,
    [workspaceId, actorId, userId],
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
  addMemberForManager,
  createWorkspaceForUser,
  deleteWorkspaceForOwner,
  getWorkspaceForMember,
  listMembersForMember,
  listWorkspacesForUser,
  removeMemberForManager,
  updateMemberRoleForOwner,
  updateWorkspaceForManager,
};
