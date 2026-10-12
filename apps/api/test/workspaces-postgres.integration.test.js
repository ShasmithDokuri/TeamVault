const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL workspace authorization integration', () => {
  let app;
  let pool;
  let request;
  const users = {};
  const tokens = {};
  const workspaceIds = {};

  async function createFixtureUser(label) {
    const { randomUUID } = require('node:crypto');
    const { createSessionToken } = require('../src/auth/tokens');
    const id = randomUUID();
    const email = `milestone4-${label}-${randomUUID()}@example.test`;
    const session = createSessionToken();
    await pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, email, 'integration-fixture-hash'],
    );
    await pool.query(
      'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [session.tokenHash, id, session.expiresAt],
    );
    users[label] = id;
    tokens[label] = session.token;
    return id;
  }

  function as(label) {
    return { Authorization: `Bearer ${tokens[label]}` };
  }

  beforeAll(async () => {
    const testUrl = process.env.TEAMVAULT_TEST_DATABASE_URL;
    const parsedUrl = new URL(testUrl);
    if (
      parsedUrl.pathname !== '/teamvault_m3_review'
      || !['', 'localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)
    ) {
      throw new Error('Integration tests require the local isolated teamvault_m3_review database.');
    }
    process.env.DATABASE_URL = testUrl;

    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    const migrationsPath = path.join(__dirname, '../migrations');
    const migrations = (await fs.readdir(migrationsPath))
      .filter((filename) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(filename))
      .sort();
    for (const filename of migrations) {
      await pool.query(await fs.readFile(path.join(migrationsPath, filename), 'utf8'));
    }

    await createFixtureUser('owner');
    await createFixtureUser('admin');
    await createFixtureUser('member');
    await createFixtureUser('outsider');

    const authRepository = require('../src/auth/user-repository');
    const authService = require('../src/auth/service').createAuthService(authRepository);
    app = require('../src/app').createApp({ authService });
    request = require('supertest');
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('enforces workspace membership, owner/admin/member permissions, and cross-workspace isolation', async () => {
    const noAuth = await request(app).get('/api/workspaces');
    expect(noAuth.status).toBe(401);

    const created = await request(app).post('/api/workspaces').set(as('owner')).send({ name: '  Product Team  ' });
    expect(created.status).toBe(201);
    expect(created.body.workspace).toMatchObject({ name: 'Product Team', role: 'owner' });
    const firstWorkspaceId = created.body.workspace.id;
    workspaceIds.first = firstWorkspaceId;

    const ownerMembership = await pool.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [firstWorkspaceId, users.owner],
    );
    expect(ownerMembership.rows[0].role).toBe('owner');

    const secondCreated = await request(app).post('/api/workspaces').set(as('outsider')).send({ name: 'Private Team' });
    expect(secondCreated.status).toBe(201);
    const secondWorkspaceId = secondCreated.body.workspace.id;
    workspaceIds.second = secondWorkspaceId;

    const ownerAddsAdmin = await request(app)
      .post(`/api/workspaces/${firstWorkspaceId}/members`).set(as('owner'))
      .send({ userId: users.admin, role: 'admin' });
    expect(ownerAddsAdmin.status).toBe(201);
    const ownerAddsMember = await request(app)
      .post(`/api/workspaces/${firstWorkspaceId}/members`).set(as('owner'))
      .send({ userId: users.member });
    expect(ownerAddsMember.status).toBe(201);

    const ownerWorkspaces = await request(app).get('/api/workspaces').set(as('owner'));
    expect(ownerWorkspaces.body.workspaces.map(({ id }) => id)).toContain(firstWorkspaceId);
    expect(ownerWorkspaces.body.workspaces.map(({ id }) => id)).not.toContain(secondWorkspaceId);
    const memberWorkspace = await request(app).get(`/api/workspaces/${firstWorkspaceId}`).set(as('member'));
    expect(memberWorkspace.status).toBe(200);
    const memberList = await request(app).get(`/api/workspaces/${firstWorkspaceId}/members`).set(as('member'));
    expect(memberList.status).toBe(200);
    expect(memberList.body.members).toHaveLength(3);

    const adminRename = await request(app).patch(`/api/workspaces/${firstWorkspaceId}`).set(as('admin'))
      .send({ name: 'Admin managed name' });
    expect(adminRename.status).toBe(200);
    const ownerRename = await request(app).patch(`/api/workspaces/${firstWorkspaceId}`).set(as('owner'))
      .send({ name: 'Product Team' });
    expect(ownerRename.status).toBe(200);

    const outsiderRead = await request(app).get(`/api/workspaces/${firstWorkspaceId}`).set(as('outsider'));
    expect(outsiderRead.status).toBe(404);
    const outsiderMembers = await request(app).get(`/api/workspaces/${firstWorkspaceId}/members`).set(as('outsider'));
    expect(outsiderMembers.status).toBe(404);

    const memberRename = await request(app).patch(`/api/workspaces/${firstWorkspaceId}`).set(as('member')).send({ name: 'Nope' });
    expect(memberRename.status).toBe(404);
    const memberAdd = await request(app).post(`/api/workspaces/${firstWorkspaceId}/members`).set(as('member'))
      .send({ userId: users.outsider });
    expect(memberAdd.status).toBe(404);
    const adminCannotGrantAdmin = await request(app).post(`/api/workspaces/${firstWorkspaceId}/members`).set(as('admin'))
      .send({ userId: users.outsider, role: 'admin' });
    expect(adminCannotGrantAdmin.status).toBe(404);
    const adminAddsMember = await request(app).post(`/api/workspaces/${firstWorkspaceId}/members`).set(as('admin'))
      .send({ userId: users.outsider, role: 'member' });
    expect(adminAddsMember.status).toBe(201);

    const adminCannotPromote = await request(app).patch(`/api/workspaces/${firstWorkspaceId}/members/${users.member}`)
      .set(as('admin')).send({ role: 'admin' });
    expect(adminCannotPromote.status).toBe(404);
    const ownerPromotes = await request(app).patch(`/api/workspaces/${firstWorkspaceId}/members/${users.member}`)
      .set(as('owner')).send({ role: 'admin' });
    expect(ownerPromotes.status).toBe(200);
    const adminCannotRemoveAdmin = await request(app).delete(`/api/workspaces/${firstWorkspaceId}/members/${users.member}`)
      .set(as('admin'));
    expect(adminCannotRemoveAdmin.status).toBe(404);
    const adminCannotManageOwnerRole = await request(app).patch(`/api/workspaces/${firstWorkspaceId}/members/${users.owner}`)
      .set(as('admin')).send({ role: 'member' });
    expect(adminCannotManageOwnerRole.status).toBe(404);
    const adminCannotRemoveOwner = await request(app).delete(`/api/workspaces/${firstWorkspaceId}/members/${users.owner}`)
      .set(as('admin'));
    expect(adminCannotRemoveOwner.status).toBe(404);
    const adminCannotPromoteSelf = await request(app).patch(`/api/workspaces/${firstWorkspaceId}/members/${users.admin}`)
      .set(as('admin')).send({ role: 'admin' });
    expect(adminCannotPromoteSelf.status).toBe(404);
    const ownerDemotes = await request(app).patch(`/api/workspaces/${firstWorkspaceId}/members/${users.member}`)
      .set(as('owner')).send({ role: 'member' });
    expect(ownerDemotes.status).toBe(200);
    const adminRemovesMember = await request(app).delete(`/api/workspaces/${firstWorkspaceId}/members/${users.member}`)
      .set(as('admin'));
    expect(adminRemovesMember.status).toBe(204);
    const removedMemberRead = await request(app).get(`/api/workspaces/${firstWorkspaceId}`).set(as('member'));
    expect(removedMemberRead.status).toBe(404);

    const ownerCannotBeDemoted = await request(app).patch(`/api/workspaces/${firstWorkspaceId}/members/${users.owner}`)
      .set(as('owner')).send({ role: 'member' });
    expect(ownerCannotBeDemoted.status).toBe(404);
    const ownerCannotBeRemoved = await request(app).delete(`/api/workspaces/${firstWorkspaceId}/members/${users.owner}`)
      .set(as('owner'));
    expect(ownerCannotBeRemoved.status).toBe(404);
    const cannotAssignOwnerRole = await request(app).post(`/api/workspaces/${firstWorkspaceId}/members`).set(as('owner'))
      .send({ userId: users.outsider, role: 'owner' });
    expect(cannotAssignOwnerRole.status).toBe(400);

    const crossWorkspaceRename = await request(app).patch(`/api/workspaces/${secondWorkspaceId}`)
      .set(as('owner')).send({ name: 'Cross-workspace mutation' });
    expect(crossWorkspaceRename.status).toBe(404);
    const crossWorkspaceAdd = await request(app).post(`/api/workspaces/${secondWorkspaceId}/members`)
      .set(as('owner')).send({ userId: users.member });
    expect(crossWorkspaceAdd.status).toBe(404);
    const secondName = await pool.query('SELECT name FROM workspaces WHERE id = $1', [secondWorkspaceId]);
    expect(secondName.rows[0].name).toBe('Private Team');
    const crossMembership = await pool.query(
      'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [secondWorkspaceId, users.member],
    );
    expect(crossMembership.rowCount).toBe(0);

    const memberDeleteWorkspace = await request(app).delete(`/api/workspaces/${firstWorkspaceId}`).set(as('member'));
    expect(memberDeleteWorkspace.status).toBe(404);
    const ownerDeleteWorkspace = await request(app).delete(`/api/workspaces/${secondWorkspaceId}`).set(as('outsider'));
    expect(ownerDeleteWorkspace.status).toBe(204);
    const deletedWorkspace = await pool.query('SELECT id FROM workspaces WHERE id = $1', [secondWorkspaceId]);
    expect(deletedWorkspace.rowCount).toBe(0);

    const invalidName = await request(app).post('/api/workspaces').set(as('owner')).send({ name: '  ' });
    expect(invalidName.status).toBe(400);

    await expect(pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [firstWorkspaceId, users.member, 'superuser'],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [firstWorkspaceId, users.admin, 'owner'],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [firstWorkspaceId, users.owner],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      "UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
      [firstWorkspaceId, users.owner],
    )).rejects.toMatchObject({ code: '23514' });
    const ownerStillPresent = await pool.query(
      "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
      [firstWorkspaceId],
    );
    expect(ownerStillPresent.rows.map(({ user_id }) => user_id)).toEqual([users.owner]);

    const concurrentOwnerMutations = await Promise.allSettled([
      pool.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [firstWorkspaceId, users.owner]),
      pool.query("UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2", [firstWorkspaceId, users.owner]),
    ]);
    expect(concurrentOwnerMutations.every((result) => (
      result.status === 'rejected' && result.reason.code === '23514'
    ))).toBe(true);
    const ownerAfterRace = await pool.query(
      "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
      [firstWorkspaceId],
    );
    expect(ownerAfterRace.rows.map(({ user_id }) => user_id)).toEqual([users.owner]);

    const truncateClient = await pool.connect();
    let truncateError;
    try {
      await truncateClient.query('BEGIN');
      try {
        await truncateClient.query('TRUNCATE workspace_members CASCADE');
      } catch (error) {
        truncateError = error;
      }
      await truncateClient.query('ROLLBACK');
    } finally {
      truncateClient.release();
    }
    expect(truncateError).toMatchObject({ code: '23514' });
    const ownerAfterTruncateAttempt = await pool.query(
      "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
      [firstWorkspaceId],
    );
    expect(ownerAfterTruncateAttempt.rows.map(({ user_id }) => user_id)).toEqual([users.owner]);
  }, 30000);
});
