const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL realtime authorization integration', () => {
  let pool;
  let app;
  let ioServer;
  let httpServer;
  let port;
  let authService;
  const fixtures = [];
  const workspaceIds = [];
  const sockets = [];

  async function createUser(label) {
    const { randomUUID } = require('node:crypto');
    const { createSessionToken } = require('../src/auth/tokens');
    const id = randomUUID();
    const session = createSessionToken();
    await pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, `milestone10-${label}-${randomUUID()}@example.test`, 'integration-fixture-hash'],
    );
    await pool.query(
      'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [session.tokenHash, id, session.expiresAt],
    );
    fixtures.push({ id, token: session.token });
    return fixtures.at(-1);
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
    const migrationPath = path.join(__dirname, '../migrations');
    const migrations = (await fs.readdir(migrationPath))
      .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    for (const name of migrations) {
      await pool.query(await fs.readFile(path.join(migrationPath, name), 'utf8'));
    }

    const first = await createUser('owner');
    const second = await createUser('other');
    authService = require('../src/auth/service').createAuthService(require('../src/auth/user-repository'));
    app = require('../src/app').createApp({ authService });
    httpServer = require('node:http').createServer(app);
    ioServer = new (require('socket.io').Server)(httpServer);
    app.locals.teamVaultRuntime.realtimeHub.attach(ioServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = httpServer.address().port;
    fixtures[0] = first;
    fixtures[1] = second;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    if (ioServer) await new Promise((resolve) => ioServer.close(resolve));
    if (pool) {
      if (workspaceIds.length) {
        await pool.query('DELETE FROM outbox_events WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
        await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
      }
      if (fixtures.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [fixtures.map(({ id }) => id)]);
      await pool.end();
    }
  });

  test('uses live database sessions and membership to isolate workspace event delivery', async () => {
    const request = require('supertest');
    const { io: connectSocket } = require('socket.io-client');
    const first = fixtures[0];
    const second = fixtures[1];
    const firstWorkspace = await request(app).post('/api/workspaces')
      .set('Authorization', `Bearer ${first.token}`).send({ name: 'M10 realtime test workspace one' });
    const secondWorkspace = await request(app).post('/api/workspaces')
      .set('Authorization', `Bearer ${second.token}`).send({ name: 'M10 realtime test workspace two' });
    expect(firstWorkspace.status).toBe(201);
    expect(secondWorkspace.status).toBe(201);
    workspaceIds.push(firstWorkspace.body.workspace.id, secondWorkspace.body.workspace.id);

    const firstSocket = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: first.token }, transports: ['websocket'], reconnection: false });
    const secondSocket = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: second.token }, transports: ['websocket'], reconnection: false });
    sockets.push(firstSocket, secondSocket);
    await Promise.all([waitFor(firstSocket, 'connect'), waitFor(secondSocket, 'connect')]);
    expect(await emitAck(firstSocket, { workspaceId: firstWorkspace.body.workspace.id })).toMatchObject({ ok: true });
    expect(await emitAck(secondSocket, { workspaceId: secondWorkspace.body.workspace.id })).toMatchObject({ ok: true });
    expect(await emitAck(secondSocket, { workspaceId: firstWorkspace.body.workspace.id }))
      .toEqual({ ok: false, error: 'workspace_not_found' });

    const firstEvent = waitFor(firstSocket, 'workspace:event');
    const noCrossWorkspaceEvent = waitFor(secondSocket, 'workspace:event', 120);
    await app.locals.teamVaultRuntime.realtimeHub.publishWorkspaceEvent({
      workspaceId: firstWorkspace.body.workspace.id,
      resourceType: 'project',
      resourceId: require('node:crypto').randomUUID(),
      action: 'created',
    });
    expect((await firstEvent).workspaceId).toBe(firstWorkspace.body.workspace.id);
    await expect(noCrossWorkspaceEvent).rejects.toThrow('timeout');

    await authService.logout(first.token, first.id);
    const noRevokedSessionEvent = waitFor(firstSocket, 'workspace:event', 120);
    await app.locals.teamVaultRuntime.realtimeHub.publishWorkspaceEvent({
      workspaceId: firstWorkspace.body.workspace.id,
      resourceType: 'project',
      resourceId: require('node:crypto').randomUUID(),
      action: 'updated',
    });
    await expect(noRevokedSessionEvent).rejects.toThrow('timeout');
  }, 15000);
});

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args[0]); });
  });
}

function emitAck(socket, payload) {
  return new Promise((resolve) => socket.emit('workspace:subscribe', payload, resolve));
}
