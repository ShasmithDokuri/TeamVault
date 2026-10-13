const { connectToTestDatabase } = require('./test-database.cjs');

module.exports = async function globalTeardown() {
  const runId = process.env.TEAMVAULT_E2E_RUN_ID;
  if (!/^[0-9a-f-]{36}$/iu.test(runId || '')) throw new Error('Missing browser-test cleanup identifier.');
  const pool = await connectToTestDatabase();
  const client = await pool.connect();
  try {
    const pattern = `teamvault-e2e-${runId}-%@e2e.test`;
    const { rows } = await pool.query(
      `SELECT DISTINCT membership.workspace_id
       FROM workspace_members AS membership
       JOIN users AS fixture_user ON fixture_user.id = membership.user_id
       WHERE fixture_user.email LIKE $1`,
      [pattern],
    );
    const workspaceIds = rows.map((row) => row.workspace_id);
    const { rows: users } = await pool.query(
      'SELECT id FROM users WHERE email LIKE $1', [pattern],
    );
    await client.query('BEGIN');
    try {
      if (workspaceIds.length) {
        await client.query('DELETE FROM outbox_events WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
        await client.query('DELETE FROM workspace_files WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
        await client.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
      }
      if (users.length) {
        await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users.map((user) => user.id)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
};
