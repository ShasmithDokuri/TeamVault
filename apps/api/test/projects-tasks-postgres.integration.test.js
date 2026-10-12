const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL projects and tasks integration', () => {
  let app;
  let pool;
  let request;
  const userIds = [];
  const workspaceIds = [];
  const users = {};
  const tokens = {};

  async function createFixtureUser(label) {
    const { randomUUID } = require('node:crypto');
    const { createSessionToken } = require('../src/auth/tokens');
    const id = randomUUID();
    const email = `milestone5-${label}-${randomUUID()}@example.test`;
    const session = createSessionToken();
    await pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, email, 'integration-fixture-hash'],
    );
    await pool.query(
      'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [session.tokenHash, id, session.expiresAt],
    );
    userIds.push(id);
    users[label] = id;
    tokens[label] = session.token;
    return id;
  }

  function as(label) {
    return { Authorization: `Bearer ${tokens[label]}` };
  }

  function workspacePath(workspaceId) {
    return `/api/workspaces/${workspaceId}`;
  }

  async function createWorkspace(label, name) {
    const response = await request(app).post('/api/workspaces').set(as(label)).send({ name });
    expect(response.status).toBe(201);
    workspaceIds.push(response.body.workspace.id);
    return response.body.workspace.id;
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
    if (pool) {
      if (workspaceIds.length > 0) {
        await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
      }
      if (userIds.length > 0) {
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      await pool.end();
    }
  });

  test('enforces project and task CRUD, workspace isolation, RBAC, validation, assignments, and concurrent updates', async () => {
    expect((await request(app).get('/api/workspaces')).status).toBe(401);
    expect((await request(app).post('/api/workspaces/not-a-uuid/projects').send({ name: 'Unauthorized' })).status).toBe(401);
    expect((await request(app).get('/api/workspaces/not-a-uuid/projects/not-a-uuid/tasks')).status).toBe(401);
    const firstWorkspaceId = await createWorkspace('owner', 'Milestone 5 workspace');
    const secondWorkspaceId = await createWorkspace('outsider', 'Other tenant workspace');

    const addAdmin = await request(app).post(`${workspacePath(firstWorkspaceId)}/members`).set(as('owner'))
      .send({ userId: users.admin, role: 'admin' });
    const addMember = await request(app).post(`${workspacePath(firstWorkspaceId)}/members`).set(as('owner'))
      .send({ userId: users.member, role: 'member' });
    expect(addAdmin.status).toBe(201);
    expect(addMember.status).toBe(201);

    const projectsPath = `${workspacePath(firstWorkspaceId)}/projects`;
    expect((await request(app).post(projectsPath).set(as('member')).send({ name: 'Member project' })).status).toBe(404);
    expect((await request(app).post(projectsPath).set(as('owner')).send({ name: '  ' })).status).toBe(400);
    expect((await request(app).post(projectsPath).set(as('owner')).send({ name: 'Valid', unexpected: true })).status).toBe(400);
    expect((await request(app).post(projectsPath).set(as('owner')).send({ name: 'Valid', description: 'x'.repeat(5001) })).status).toBe(400);

    const firstProjectResponse = await request(app).post(projectsPath).set(as('owner'))
      .send({ name: '  Roadmap  ', description: 'Initial plan' });
    expect(firstProjectResponse.status).toBe(201);
    expect(firstProjectResponse.body.project).toMatchObject({ name: 'Roadmap', description: 'Initial plan' });
    const firstProjectId = firstProjectResponse.body.project.id;
    const projectsPathById = `${projectsPath}/${firstProjectId}`;

    const secondProjectResponse = await request(app).post(`${workspacePath(secondWorkspaceId)}/projects`).set(as('outsider'))
      .send({ name: 'Private project' });
    expect(secondProjectResponse.status).toBe(201);
    const secondProjectId = secondProjectResponse.body.project.id;
    const privateTaskResponse = await request(app)
      .post(`${workspacePath(secondWorkspaceId)}/projects/${secondProjectId}/tasks`).set(as('outsider'))
      .send({ title: 'Private tenant task' });
    expect(privateTaskResponse.status).toBe(201);
    const privateTaskId = privateTaskResponse.body.task.id;

    const adminProject = await request(app).post(projectsPath).set(as('admin')).send({ name: 'Admin project' });
    expect(adminProject.status).toBe(201);
    const adminProjectId = adminProject.body.project.id;
    const memberProjects = await request(app).get(projectsPath).set(as('member'));
    expect(memberProjects.status).toBe(200);
    expect(memberProjects.body.projects.map(({ id }) => id)).toContain(firstProjectId);
    const outsiderProjectList = await request(app).get(projectsPath).set(as('outsider'));
    expect(outsiderProjectList.status).toBe(404);
    expect((await request(app).get(`${projectsPath}/${secondProjectId}`).set(as('owner'))).status).toBe(404);

    const memberProjectUpdate = await request(app).patch(projectsPathById).set(as('member')).send({ name: 'Forbidden' });
    expect(memberProjectUpdate.status).toBe(404);
    const adminProjectUpdate = await request(app).patch(projectsPathById).set(as('admin')).send({ description: 'Reviewed plan' });
    expect(adminProjectUpdate.status).toBe(200);
    expect(adminProjectUpdate.body.project).toMatchObject({ name: 'Roadmap', description: 'Reviewed plan' });
    const clearProjectDescription = await request(app).patch(projectsPathById).set(as('owner'))
      .send({ description: null });
    expect(clearProjectDescription.status).toBe(200);
    expect(clearProjectDescription.body.project.description).toBeNull();
    expect((await request(app).patch(projectsPathById).set(as('owner')).send({})).status).toBe(400);
    expect((await request(app).delete(projectsPathById).set(as('member'))).status).toBe(404);

    const tasksPath = `${projectsPathById}/tasks`;
    const invalidTaskRequests = [
      { title: '   ' },
      { title: 'Valid', status: 'queued' },
      { title: 'Valid', priority: 'critical' },
      { title: 'Valid', dueDate: '2026-02-30' },
      { title: 'Valid', dueDate: '0000-01-01' },
      { title: 'Valid', description: 'x'.repeat(10001) },
      { title: 'Valid', extra: 'not allowed' },
    ];
    for (const input of invalidTaskRequests) {
      expect((await request(app).post(tasksPath).set(as('member')).send(input)).status).toBe(400);
    }
    expect((await request(app).post(tasksPath).set(as('outsider')).send({ title: 'Not a member' })).status).toBe(404);

    const badAssignee = await request(app).post(tasksPath).set(as('member'))
      .send({ title: 'Cross-tenant assignment', assigneeId: users.outsider });
    expect(badAssignee.status).toBe(400);
    const createdTask = await request(app).post(tasksPath).set(as('member')).send({
      title: '  Prepare release  ',
      description: 'Review and package',
      status: 'todo',
      priority: 'medium',
      assigneeId: users.member,
      dueDate: '2027-01-15',
    });
    expect(createdTask.status).toBe(201);
    expect(createdTask.body.task).toMatchObject({
      title: 'Prepare release',
      status: 'todo',
      priority: 'medium',
      assigneeId: users.member,
      dueDate: '2027-01-15',
      version: 1,
    });
    const taskId = createdTask.body.task.id;
    const taskPath = `${tasksPath}/${taskId}`;

    const taskList = await request(app).get(tasksPath).set(as('member'));
    expect(taskList.status).toBe(200);
    expect(taskList.body.tasks.map(({ id }) => id)).toContain(taskId);
    expect((await request(app).get(tasksPath).set(as('outsider'))).status).toBe(404);
    expect((await request(app).get(`${workspacePath(firstWorkspaceId)}/projects/${secondProjectId}/tasks`).set(as('owner'))).status).toBe(404);
    expect((await request(app).get(`${workspacePath(firstWorkspaceId)}/projects/${firstProjectId}/tasks/${taskId}`).set(as('outsider'))).status).toBe(404);
    expect((await request(app).get(`${tasksPath}/${privateTaskId}`).set(as('owner'))).status).toBe(404);
    expect((await request(app).patch(`${tasksPath}/${privateTaskId}`).set(as('owner'))
      .send({ version: 1, status: 'done' })).status).toBe(404);
    expect((await request(app).delete(`${tasksPath}/${privateTaskId}`).set(as('owner'))).status).toBe(404);
    expect((await request(app).get(taskPath).set(as('member'))).status).toBe(200);

    const concurrentUpdates = await Promise.all([
      request(app).patch(taskPath).set(as('member')).send({ version: 1, status: 'done' }),
      request(app).patch(taskPath).set(as('member')).send({ version: 1, priority: 'high' }),
    ]);
    expect(concurrentUpdates.map(({ status }) => status).sort()).toEqual([200, 409]);
    const currentTask = (await request(app).get(taskPath).set(as('owner'))).body.task;
    const fullUpdate = await request(app).patch(taskPath).set(as('member')).send({
      version: currentTask.version,
      title: 'Release candidate',
      description: 'Ready for sign off',
      status: 'in_progress',
      priority: 'urgent',
      assigneeId: users.admin,
      dueDate: '2027-02-01',
    });
    expect(fullUpdate.status).toBe(200);
    expect(fullUpdate.body.task).toMatchObject({
      title: 'Release candidate', status: 'in_progress', priority: 'urgent',
      assigneeId: users.admin, dueDate: '2027-02-01', version: currentTask.version + 1,
    });
    expect((await request(app).patch(taskPath).set(as('member')).send({ version: 1, status: 'done' })).status).toBe(409);
    expect((await request(app).patch(taskPath).set(as('member')).send({ version: fullUpdate.body.task.version, status: 'waiting' })).status).toBe(400);
    expect((await request(app).patch(taskPath).set(as('member')).send({ version: fullUpdate.body.task.version, assigneeId: users.outsider })).status).toBe(400);

    const taskRow = await pool.query('SELECT assignee_id FROM tasks WHERE id = $1 AND workspace_id = $2', [taskId, firstWorkspaceId]);
    expect(taskRow.rows[0].assignee_id).toBe(users.admin);
    await expect(pool.query(
      `INSERT INTO tasks (id, workspace_id, project_id, title, created_by, assignee_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [require('node:crypto').randomUUID(), firstWorkspaceId, firstProjectId, 'Invalid assignee FK', users.owner, users.outsider],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      `INSERT INTO tasks (id, workspace_id, project_id, title, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [require('node:crypto').randomUUID(), firstWorkspaceId, secondProjectId, 'Invalid project FK', users.owner],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      `INSERT INTO tasks (id, workspace_id, project_id, title, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [require('node:crypto').randomUUID(), firstWorkspaceId, firstProjectId, 'Invalid status', 'waiting', users.owner],
    )).rejects.toMatchObject({ code: '23514' });

    expect((await request(app).delete(taskPath).set(as('member'))).status).toBe(404);
    const memberTaskUpdate = await request(app).patch(taskPath).set(as('member')).send({
      version: fullUpdate.body.task.version,
      assigneeId: users.member,
    });
    expect(memberTaskUpdate.status).toBe(200);
    const removeAssignee = await request(app).delete(`${workspacePath(firstWorkspaceId)}/members/${users.member}`).set(as('owner'));
    expect(removeAssignee.status).toBe(204);
    const taskAfterMemberRemoval = await pool.query('SELECT assignee_id FROM tasks WHERE id = $1', [taskId]);
    expect(taskAfterMemberRemoval.rows[0].assignee_id).toBeNull();

    const raceTaskResponse = await request(app).post(tasksPath).set(as('owner')).send({ title: 'Update and delete race' });
    expect(raceTaskResponse.status).toBe(201);
    const raceTaskPath = `${tasksPath}/${raceTaskResponse.body.task.id}`;
    const updateDeleteRace = await Promise.all([
      request(app).patch(raceTaskPath).set(as('admin')).send({ version: 1, status: 'done' }),
      request(app).delete(raceTaskPath).set(as('owner')),
    ]);
    expect(updateDeleteRace[1].status).toBe(204);
    expect([200, 404]).toContain(updateDeleteRace[0].status);
    expect((await request(app).get(raceTaskPath).set(as('owner'))).status).toBe(404);

    const adminDeleteTaskResponse = await request(app).post(tasksPath).set(as('admin')).send({ title: 'Admin delete target' });
    expect(adminDeleteTaskResponse.status).toBe(201);
    const adminDeleteTask = await request(app).delete(`${tasksPath}/${adminDeleteTaskResponse.body.task.id}`).set(as('admin'));
    expect(adminDeleteTask.status).toBe(204);

    const adminDelete = await request(app).delete(`${workspacePath(firstWorkspaceId)}/projects/${adminProjectId}`).set(as('admin'));
    expect(adminDelete.status).toBe(204);
    const deletedAdminProject = await pool.query('SELECT id FROM projects WHERE id = $1', [adminProjectId]);
    expect(deletedAdminProject.rowCount).toBe(0);

    const deleteProjectWithTasks = await request(app).delete(projectsPathById).set(as('owner'));
    expect(deleteProjectWithTasks.status).toBe(204);
    const cascadedTasks = await pool.query('SELECT id FROM tasks WHERE id = $1', [taskId]);
    expect(cascadedTasks.rowCount).toBe(0);
  }, 30000);
});
