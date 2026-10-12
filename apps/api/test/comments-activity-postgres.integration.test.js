const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL comments and activity integration', () => {
  let app;
  let pool;
  let request;
  const userIds = [];
  const workspaceIds = [];
  const users = {};
  const tokens = {};

  async function createUser(label) {
    const { randomUUID } = require('node:crypto');
    const { createSessionToken } = require('../src/auth/tokens');
    const id = randomUUID();
    const session = createSessionToken();
    await pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, `milestone6-${label}-${randomUUID()}@example.test`, 'integration-fixture-hash'],
    );
    await pool.query(
      'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [session.tokenHash, id, session.expiresAt],
    );
    userIds.push(id);
    users[label] = id;
    tokens[label] = session.token;
  }

  const auth = (label) => ({ Authorization: `Bearer ${tokens[label]}` });
  const wsPath = (id) => `/api/workspaces/${id}`;

  async function createWorkspace(label, name) {
    const response = await request(app).post('/api/workspaces').set(auth(label)).send({ name });
    expect(response.status).toBe(201);
    workspaceIds.push(response.body.workspace.id);
    return response.body.workspace.id;
  }

  beforeAll(async () => {
    const testUrl = process.env.TEAMVAULT_TEST_DATABASE_URL;
    const parsedUrl = new URL(testUrl);
    if (parsedUrl.pathname !== '/teamvault_m3_review'
      || !['', 'localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
      throw new Error('Integration tests require the local isolated teamvault_m3_review database.');
    }
    process.env.DATABASE_URL = testUrl;
    const fs = require('node:fs/promises');
    const path = require('node:path');
    pool = require('../src/db/pool').getPool();
    const migrationsPath = path.join(__dirname, '../migrations');
    const migrationNames = (await fs.readdir(migrationsPath))
      .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    for (const filename of migrationNames) {
      await pool.query(await fs.readFile(path.join(migrationsPath, filename), 'utf8'));
    }
    await createUser('owner');
    await createUser('member');
    await createUser('other');
    const authRepository = require('../src/auth/user-repository');
    const authService = require('../src/auth/service').createAuthService(authRepository);
    app = require('../src/app').createApp({ authService });
    request = require('supertest');
  });

  afterAll(async () => {
    if (!pool) return;
    if (workspaceIds.length) {
      await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
    }
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
  });

  test('scopes comments and activity to members and records safe events atomically', async () => {
    expect((await request(app).get('/api/workspaces/not-a-uuid/activity')).status).toBe(401);
    expect((await request(app).get('/api/workspaces/not-a-uuid/projects/not-a-uuid/comments')).status).toBe(401);

    const workspaceId = await createWorkspace('owner', 'Comments workspace');
    const otherWorkspaceId = await createWorkspace('other', 'Separate comments workspace');
    const addedMember = await request(app).post(`${wsPath(workspaceId)}/members`).set(auth('owner'))
      .send({ userId: users.member, role: 'member' });
    expect(addedMember.status).toBe(201);

    const triggerSuffix = require('node:crypto').randomUUID().replaceAll('-', '');
    const functionName = `m6_reject_activity_${triggerSuffix}`;
    const triggerName = `m6_reject_activity_${triggerSuffix}`;
    try {
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced activity failure' USING ERRCODE = '23514';
          RETURN NEW;
        END
      $$`);
      await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON activity_events
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      const beforeFailure = await pool.query(
        'SELECT (SELECT COUNT(*) FROM projects WHERE workspace_id = $1) AS project_count, (SELECT COUNT(*) FROM activity_events WHERE workspace_id = $1) AS event_count',
        [workspaceId],
      );
      const failedCreate = await request(app).post(`${wsPath(workspaceId)}/projects`).set(auth('owner'))
        .send({ name: 'Must roll back with activity' });
      expect(failedCreate.status).toBe(500);
      expect(failedCreate.body).toEqual({ error: 'Internal server error' });
      const afterFailure = await pool.query(
        'SELECT (SELECT COUNT(*) FROM projects WHERE workspace_id = $1) AS project_count, (SELECT COUNT(*) FROM activity_events WHERE workspace_id = $1) AS event_count',
        [workspaceId],
      );
      expect(afterFailure.rows[0]).toEqual(beforeFailure.rows[0]);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON activity_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const projectResponse = await request(app).post(`${wsPath(workspaceId)}/projects`).set(auth('owner'))
      .send({ name: 'Project discussion' });
    expect(projectResponse.status).toBe(201);
    const projectId = projectResponse.body.project.id;
    expect((await request(app).patch(`${wsPath(workspaceId)}/projects/${projectId}`).set(auth('owner'))
      .send({ name: 'Project discussion updated' })).status).toBe(200);
    const taskResponse = await request(app)
      .post(`${wsPath(workspaceId)}/projects/${projectId}/tasks`).set(auth('member'))
      .send({ title: 'Task discussion' });
    expect(taskResponse.status).toBe(201);
    const taskId = taskResponse.body.task.id;

    const projectCommentsPath = `${wsPath(workspaceId)}/projects/${projectId}/comments`;
    expect((await request(app).post(projectCommentsPath).set(auth('owner')).send({ content: '  ' })).status).toBe(400);
    expect((await request(app).post(projectCommentsPath).set(auth('owner'))
      .send({ content: 'valid', internal: 'unexpected' })).status).toBe(400);
    expect((await request(app).post(projectCommentsPath).set(auth('other'))
      .send({ content: 'cross-tenant' })).status).toBe(404);
    const projectComment = await request(app).post(projectCommentsPath).set(auth('member'))
      .send({ content: 'Project level note' });
    expect(projectComment.status).toBe(201);
    expect(projectComment.body.comment).toMatchObject({
      projectId, taskId: null, authorId: users.member, content: 'Project level note', version: 1,
    });
    const otherProject = await request(app).post(`${wsPath(otherWorkspaceId)}/projects`).set(auth('other'))
      .send({ name: 'Other tenant project' });
    expect(otherProject.status).toBe(201);
    const otherComment = await request(app)
      .post(`${wsPath(otherWorkspaceId)}/projects/${otherProject.body.project.id}/comments`).set(auth('other'))
      .send({ content: 'Private other tenant note' });
    expect(otherComment.status).toBe(201);
    expect((await request(app).patch(`${projectCommentsPath}/${otherComment.body.comment.id}`).set(auth('member'))
      .send({ content: 'cross-tenant edit', version: 1 })).status).toBe(404);
    expect((await request(app).delete(`${projectCommentsPath}/${otherComment.body.comment.id}`).set(auth('owner'))).status)
      .toBe(404);

    const taskCommentsPath = `${wsPath(workspaceId)}/projects/${projectId}/tasks/${taskId}/comments`;
    const taskComment = await request(app).post(taskCommentsPath).set(auth('owner'))
      .send({ content: 'Task review note' });
    expect(taskComment.status).toBe(201);
    const taskCommentId = taskComment.body.comment.id;
    expect((await request(app).get(taskCommentsPath).set(auth('member'))).body.comments)
      .toEqual([expect.objectContaining({ id: taskCommentId, taskId, content: 'Task review note' })]);
    expect((await request(app).get(`${wsPath(otherWorkspaceId)}/projects/${projectId}/comments`).set(auth('other'))).status)
      .toBe(404);
    expect((await request(app).get(`${wsPath(workspaceId)}/projects/${projectId}/tasks/${taskId}/comments`).set(auth('other'))).status)
      .toBe(404);

    const commentEditPath = `${taskCommentsPath}/${taskCommentId}`;
    expect((await request(app).patch(commentEditPath).set(auth('member'))
      .send({ content: 'unauthorized edit', version: 1 })).status).toBe(404);
    const updatedComment = await request(app).patch(commentEditPath).set(auth('owner'))
      .send({ content: 'Updated task note', version: 1 });
    expect(updatedComment.status).toBe(200);
    expect(updatedComment.body.comment).toMatchObject({ content: 'Updated task note', version: 2 });
    expect((await request(app).patch(commentEditPath).set(auth('owner'))
      .send({ content: 'stale edit', version: 1 })).status).toBe(409);
    const concurrentEdits = await Promise.all([
      request(app).patch(commentEditPath).set(auth('owner')).send({ content: 'Concurrent one', version: 2 }),
      request(app).patch(commentEditPath).set(auth('owner')).send({ content: 'Concurrent two', version: 2 }),
    ]);
    expect(concurrentEdits.map(({ status }) => status).sort()).toEqual([200, 409]);

    const taskUpdate = await request(app).patch(`${wsPath(workspaceId)}/projects/${projectId}/tasks/${taskId}`)
      .set(auth('member')).send({ version: 1, status: 'done', assigneeId: users.member });
    expect(taskUpdate.status).toBe(200);
    const taskFieldUpdate = await request(app).patch(`${wsPath(workspaceId)}/projects/${projectId}/tasks/${taskId}`)
      .set(auth('member')).send({ version: taskUpdate.body.task.version, status: 'in_progress' });
    expect(taskFieldUpdate.status).toBe(200);
    const otherActivity = await request(app).get(`${wsPath(otherWorkspaceId)}/activity`).set(auth('other'));
    expect(otherActivity.status).toBe(200);
    expect(otherActivity.body.events.map(({ entityId }) => entityId)).not.toContain(projectId);
    expect((await request(app).get(`${wsPath(workspaceId)}/activity`).set(auth('other'))).status).toBe(404);
    const activityPath = `${wsPath(workspaceId)}/activity`;
    const firstPage = await request(app).get(activityPath).set(auth('member')).query({ limit: 2 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.events).toHaveLength(2);
    expect(Number(firstPage.body.events[0].id)).toBeGreaterThan(Number(firstPage.body.events[1].id));
    const secondPage = await request(app).get(activityPath).set(auth('member'))
      .query({ limit: 100, before: firstPage.body.events[1].id });
    expect(secondPage.status).toBe(200);
    const allEvents = [...firstPage.body.events, ...secondPage.body.events];
    expect(allEvents.map(({ eventType }) => eventType)).toEqual(expect.arrayContaining([
      'project_created', 'project_updated', 'task_created', 'task_updated', 'comment_created',
      'comment_updated', 'task_assigned',
    ]));
    expect(JSON.stringify(allEvents)).not.toContain('Updated task note');
    expect(JSON.stringify(allEvents)).not.toContain('Project level note');
    expect((await request(app).get(activityPath).set(auth('member')).query({ limit: 0 })).status).toBe(400);
    expect((await request(app).get(activityPath).set(auth('member')).query({ before: 'not-a-cursor' })).status).toBe(400);

    const deleteOwnComment = await request(app).delete(`${projectCommentsPath}/${projectComment.body.comment.id}`)
      .set(auth('member'));
    expect(deleteOwnComment.status).toBe(204);
    expect((await request(app).delete(commentEditPath).set(auth('member'))).status).toBe(404);
    expect((await request(app).delete(commentEditPath).set(auth('owner'))).status).toBe(204);
    const commentDeleteEvent = await pool.query(
      `SELECT event_type, entity_id, metadata FROM activity_events
       WHERE workspace_id = $1 AND event_type = 'comment_deleted' AND entity_id = $2`,
      [workspaceId, projectComment.body.comment.id],
    );
    expect(commentDeleteEvent.rowCount).toBe(1);
    expect((await request(app).delete(`${wsPath(workspaceId)}/projects/${projectId}/tasks/${taskId}`)
      .set(auth('owner'))).status).toBe(204);
    expect((await pool.query(
      `SELECT 1 FROM activity_events WHERE workspace_id = $1 AND event_type = 'task_deleted' AND entity_id = $2`,
      [workspaceId, taskId],
    )).rowCount).toBe(1);
    const raceTask = await request(app).post(`${wsPath(workspaceId)}/projects/${projectId}/tasks`)
      .set(auth('member')).send({ title: 'Comment deletion race' });
    expect(raceTask.status).toBe(201);
    const raceTaskId = raceTask.body.task.id;
    const raceCommentsPath = `${wsPath(workspaceId)}/projects/${projectId}/tasks/${raceTaskId}/comments`;
    const raceComment = await request(app).post(raceCommentsPath).set(auth('member'))
      .send({ content: 'Race target' });
    expect(raceComment.status).toBe(201);
    const commentTaskDeleteRace = await Promise.all([
      request(app).delete(`${raceCommentsPath}/${raceComment.body.comment.id}`).set(auth('member')),
      request(app).delete(`${wsPath(workspaceId)}/projects/${projectId}/tasks/${raceTaskId}`).set(auth('owner')),
    ]);
    expect([204, 404]).toContain(commentTaskDeleteRace[0].status);
    expect(commentTaskDeleteRace[1].status).toBe(204);
    expect((await request(app).get(raceCommentsPath).set(auth('member'))).status).toBe(404);
    const retainedComment = await request(app).post(projectCommentsPath).set(auth('member'))
      .send({ content: 'Retained after author leaves' });
    expect(retainedComment.status).toBe(201);
    expect((await request(app).delete(`${wsPath(workspaceId)}/members/${users.member}`).set(auth('owner'))).status)
      .toBe(204);
    const retainedComments = await request(app).get(projectCommentsPath).set(auth('owner'));
    expect(retainedComments.body.comments).toEqual([
      expect.objectContaining({ id: retainedComment.body.comment.id, authorId: null }),
    ]);
    expect((await request(app).delete(`${wsPath(workspaceId)}/projects/${projectId}`).set(auth('owner'))).status)
      .toBe(204);
    expect((await pool.query(
      `SELECT 1 FROM activity_events WHERE workspace_id = $1 AND event_type = 'project_deleted' AND entity_id = $2`,
      [workspaceId, projectId],
    )).rowCount).toBe(1);

    const deletionWorkspaceId = await createWorkspace('owner', 'Workspace deletion race');
    const deletionProject = await request(app).post(`${wsPath(deletionWorkspaceId)}/projects`).set(auth('owner'))
      .send({ name: 'Workspace deletion target' });
    expect(deletionProject.status).toBe(201);
    const workspaceCommentPath = `${wsPath(deletionWorkspaceId)}/projects/${deletionProject.body.project.id}/comments`;
    const workspaceDeleteRace = await Promise.all([
      request(app).post(workspaceCommentPath).set(auth('owner')).send({ content: 'Concurrent with deletion' }),
      request(app).delete(wsPath(deletionWorkspaceId)).set(auth('owner')),
    ]);
    expect([201, 404]).toContain(workspaceDeleteRace[0].status);
    expect(workspaceDeleteRace[1].status).toBe(204);
  }, 30000);
});
