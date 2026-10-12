const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL private file integration', () => {
  let app;
  let pool;
  let request;
  let objects;
  let objectStore;
  const userIds = [];
  const workspaceIds = [];
  const users = {};
  const tokens = {};
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=', 'base64');

  async function createUser(label) {
    const { randomUUID } = require('node:crypto');
    const { createSessionToken } = require('../src/auth/tokens');
    const id = randomUUID();
    const session = createSessionToken();
    await pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, `milestone9-${label}-${randomUUID()}@example.test`, 'integration-fixture-hash'],
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
  const wsPath = (workspaceId) => `/api/workspaces/${workspaceId}`;

  async function createWorkspace(label, name) {
    const response = await request(app).post('/api/workspaces').set(auth(label)).send({ name });
    expect(response.status).toBe(201);
    workspaceIds.push(response.body.workspace.id);
    return response.body.workspace.id;
  }

  beforeAll(async () => {
    const testUrl = process.env.TEAMVAULT_TEST_DATABASE_URL;
    const parsed = new URL(testUrl);
    if (parsed.pathname !== '/teamvault_m3_review'
      || !['', 'localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Integration tests require the local isolated teamvault_m3_review database.');
    }
    process.env.DATABASE_URL = testUrl;
    const fs = require('node:fs/promises');
    const path = require('node:path');
    pool = require('../src/db/pool').getPool();
    const migrationsPath = path.join(__dirname, '../migrations');
    const migrations = (await fs.readdir(migrationsPath))
      .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    for (const migration of migrations) {
      await pool.query(await fs.readFile(path.join(migrationsPath, migration), 'utf8'));
    }

    await createUser('owner');
    await createUser('member');
    await createUser('admin');
    await createUser('other');
    objects = new Map();
    let failNextPut = false;
    objectStore = {
      async put({ key, body }) {
        if (failNextPut) {
          failNextPut = false;
          throw new Error('injected private object storage failure');
        }
        objects.set(key, Buffer.from(body));
      },
      async get({ key }) {
        const bytes = objects.get(key);
        if (!bytes) throw new Error('object is unavailable');
        return { Body: require('node:stream').Readable.from([bytes]) };
      },
      async delete({ key }) { objects.delete(key); },
      failNextUpload() { failNextPut = true; },
    };
    const authService = require('../src/auth/service').createAuthService(require('../src/auth/user-repository'));
    const services = require('../src/services/create-services').createServices({}, {
      fileConfig: { enabled: true, maxFileBytes: 10 * 1024 * 1024 },
      fileObjectStore: objectStore,
    });
    app = require('../src/app').createApp({ authService, services });
    request = require('supertest');
  });

  afterAll(async () => {
    if (!pool) return;
    if (objects) objects.clear();
    if (workspaceIds.length) {
      await pool.query('DELETE FROM workspace_files WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
      await pool.query('DELETE FROM outbox_events WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
      await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
    }
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await pool.end();
  });

  test('enforces member access, project/task scope, private upload recovery, and uploader/manager deletion rules', async () => {
    expect((await request(app).post('/api/workspaces/not-a-uuid/projects/not-a-uuid/files').send(png)).status).toBe(401);

    const firstWorkspace = await createWorkspace('owner', 'M9 files workspace');
    const secondWorkspace = await createWorkspace('other', 'M9 other workspace');
    expect((await request(app).post(`${wsPath(firstWorkspace)}/members`).set(auth('owner'))
      .send({ userId: users.member, role: 'member' })).status).toBe(201);
    expect((await request(app).post(`${wsPath(firstWorkspace)}/members`).set(auth('owner'))
      .send({ userId: users.admin, role: 'admin' })).status).toBe(201);
    const firstProject = (await request(app).post(`${wsPath(firstWorkspace)}/projects`).set(auth('owner'))
      .send({ name: 'Private file project' })).body.project;
    const secondProject = (await request(app).post(`${wsPath(secondWorkspace)}/projects`).set(auth('other'))
      .send({ name: 'Separate file project' })).body.project;
    const secondTask = (await request(app).post(`${wsPath(secondWorkspace)}/projects/${secondProject.id}/tasks`).set(auth('other'))
      .send({ title: 'Other tenant task' })).body.task;
    const task = (await request(app).post(`${wsPath(firstWorkspace)}/projects/${firstProject.id}/tasks`).set(auth('owner'))
      .send({ title: 'Attachment task' })).body.task;
    const projectFiles = `${wsPath(firstWorkspace)}/projects/${firstProject.id}/files`;
    const taskFiles = `${wsPath(firstWorkspace)}/projects/${firstProject.id}/tasks/${task.id}/files`;
    expect((await request(app).get(projectFiles)).status).toBe(401);
    expect((await request(app).delete(`${projectFiles}/22222222-2222-4222-8222-222222222222`)).status).toBe(401);
    await expect(pool.query(
      `INSERT INTO workspace_files
         (id, workspace_id, project_id, task_id, uploaded_by, object_key, original_name, content_type, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'cross.png', 'image/png', 9, 'available')`,
      [require('node:crypto').randomUUID(), firstWorkspace, firstProject.id, secondTask.id, users.owner,
        `private/${firstWorkspace}/${require('node:crypto').randomUUID()}/${require('node:crypto').randomUUID()}`],
    )).rejects.toMatchObject({ code: '23503', constraint: 'workspace_files_task_project_workspace_fk' });
    await expect(pool.query(
      `INSERT INTO workspace_files
         (id, workspace_id, project_id, uploaded_by, object_key, original_name, content_type, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'wrong-member.png', 'image/png', 9, 'available')`,
      [require('node:crypto').randomUUID(), firstWorkspace, firstProject.id, users.other,
        `private/${firstWorkspace}/${require('node:crypto').randomUUID()}/${require('node:crypto').randomUUID()}`],
    )).rejects.toMatchObject({ code: '23503', constraint: 'workspace_files_uploader_workspace_member_fk' });

    expect((await request(app).post(projectFiles).set(auth('owner')).set('Content-Type', 'image/png')
      .set('X-File-Name', 'bad.png').send(Buffer.from('not a png'))).status).toBe(400);

    const upload = await request(app).post(projectFiles).set(auth('owner'))
      .set('Content-Type', 'image/png').set('X-File-Name', 'diagram.png').send(png);
    expect(upload.status).toBe(201);
    const file = upload.body.file;
    expect(file).toMatchObject({ originalName: 'diagram.png', contentType: 'image/png', sizeBytes: png.length, status: 'available' });
    expect(file).not.toHaveProperty('objectKey');
    const stored = await pool.query('SELECT object_key, status FROM workspace_files WHERE workspace_id = $1 AND id = $2', [firstWorkspace, file.id]);
    expect(stored.rows[0].object_key).toMatch(/^private\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+$/u);
    expect(stored.rows[0].object_key).not.toContain('diagram');
    expect(stored.rows[0].status).toBe('available');

    expect((await request(app).get(`${projectFiles}/${file.id}`).set(auth('member'))).status).toBe(200);
    const download = await request(app).get(`${projectFiles}/${file.id}`).set(auth('member'));
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.body).toEqual(png);
    expect((await request(app).get(projectFiles).set(auth('member'))).body.files).toHaveLength(1);
    expect((await request(app).get(`${wsPath(secondWorkspace)}/projects/${secondProject.id}/files/${file.id}`).set(auth('other'))).status)
      .toBe(404);
    expect((await request(app).get(`${wsPath(firstWorkspace)}/projects/${secondProject.id}/files/${file.id}`).set(auth('owner'))).status)
      .toBe(404);
    expect((await request(app).get(`${wsPath(firstWorkspace)}/projects/${'55555555-5555-4555-8555-555555555555'}/files`).set(auth('owner'))).status)
      .toBe(404);
    expect((await request(app).delete(`${projectFiles}/${file.id}`).set(auth('member'))).status).toBe(404);
    const pendingId = require('node:crypto').randomUUID();
    const pendingToken = require('node:crypto').randomUUID();
    await pool.query(
      `INSERT INTO workspace_files
         (id, workspace_id, project_id, uploaded_by, object_key, original_name, content_type, size_bytes, status, upload_token)
       VALUES ($1, $2, $3, $4, $5, 'pending.png', 'image/png', $6, 'pending', $7)`,
      [pendingId, firstWorkspace, firstProject.id, users.owner,
        `private/${firstWorkspace}/${pendingId}/${require('node:crypto').randomUUID()}`, png.length, pendingToken],
    );
    expect((await request(app).delete(`${projectFiles}/${pendingId}`).set(auth('owner'))).status).toBe(404);
    await pool.query('DELETE FROM workspace_files WHERE workspace_id = $1 AND id = $2', [firstWorkspace, pendingId]);
    const projectDeleteBlocked = await request(app).delete(`${wsPath(firstWorkspace)}/projects/${firstProject.id}`).set(auth('owner'));
    expect(projectDeleteBlocked).toMatchObject({
      status: 409,
      body: { error: 'Delete attached files before removing this resource.' },
    });
    expect((await request(app).delete(wsPath(firstWorkspace)).set(auth('owner'))).status).toBe(409);
    expect((await request(app).delete(`${projectFiles}/${file.id}`).set(auth('admin'))).status).toBe(204);

    const memberUpload = await request(app).post(taskFiles).set(auth('member'))
      .set('Content-Type', 'image/png').set('X-File-Name', 'task.png').send(png);
    expect(memberUpload.status).toBe(201);
    expect((await request(app).delete(`${wsPath(firstWorkspace)}/projects/${firstProject.id}/tasks/${task.id}`).set(auth('owner'))).status)
      .toBe(409);
    expect((await request(app).delete(`${taskFiles}/${memberUpload.body.file.id}`).set(auth('member'))).status).toBe(204);

    expect((await request(app)
      .post(`${wsPath(firstWorkspace)}/projects/${secondProject.id}/tasks/${task.id}/files`).set(auth('owner'))
      .set('Content-Type', 'image/png').set('X-File-Name', 'cross.png').send(png)).status).toBe(404);

    objectStore.failNextUpload();
    const failed = await request(app).post(projectFiles).set(auth('owner'))
      .set('Content-Type', 'image/png').set('X-File-Name', 'retry.png').send(png);
    expect(failed.status).toBe(503);
    expect(failed.body.fileId).toBeDefined();
    const failedRow = await pool.query('SELECT status FROM workspace_files WHERE id = $1 AND workspace_id = $2', [failed.body.fileId, firstWorkspace]);
    expect(failedRow.rows[0].status).toBe('failed');
    const retried = await request(app).put(`${projectFiles}/${failed.body.fileId}/content`).set(auth('owner'))
      .set('Content-Type', 'image/png').set('X-File-Name', 'retry.png').send(png);
    expect(retried.status).toBe(200);

    const suffix = require('node:crypto').randomUUID().replaceAll('-', '');
    const functionName = `m9_fail_file_finalize_${suffix}`;
    const triggerName = `m9_fail_file_finalize_${suffix}`;
    let consistencyFailure;
    try {
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'available' THEN RAISE EXCEPTION 'injected metadata failure' USING ERRCODE = '23514'; END IF;
          RETURN NEW;
        END
      $$`);
      await pool.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON workspace_files
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      consistencyFailure = await request(app).post(projectFiles).set(auth('owner'))
        .set('Content-Type', 'image/png').set('X-File-Name', 'recover.png').send(png);
      expect(consistencyFailure.status).toBe(503);
      const state = await pool.query('SELECT status FROM workspace_files WHERE id = $1 AND workspace_id = $2', [consistencyFailure.body.fileId, firstWorkspace]);
      expect(state.rows[0].status).toBe('failed');
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON workspace_files`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const recovered = await request(app).put(`${projectFiles}/${consistencyFailure.body.fileId}/content`).set(auth('owner'))
      .set('Content-Type', 'image/png').set('X-File-Name', 'recover.png').send(png);
    expect(recovered.status).toBe(200);

    expect((await request(app).delete(`${projectFiles}/${retried.body.file.id}`).set(auth('owner'))).status).toBe(204);
    expect((await request(app).delete(`${projectFiles}/${recovered.body.file.id}`).set(auth('owner'))).status).toBe(204);
    expect((await request(app).delete(`${wsPath(firstWorkspace)}/projects/${firstProject.id}`).set(auth('owner'))).status)
      .toBe(204);
  });
});
