const { createServer } = require('node:http');
const { EventEmitter } = require('node:events');
const { Server } = require('socket.io');
const { io: createSocket } = require('socket.io-client');
const { createRealtimeHub } = require('../src/realtime/hub');
const { readRealtimeConfig } = require('../src/realtime/config');
const { createRedisRuntime, createResilientRateLimitStore } = require('../src/realtime/redis');

const TOKEN = 'a'.repeat(43);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RESOURCE = '33333333-3333-4333-8333-333333333333';

describe('realtime security and Redis fallback', () => {
  let httpServer;
  let socketServer;
  let port;
  let hub;
  let members;
  let clients;
  let sessions;

  beforeEach(async () => {
    members = new Set([`user-1:${WORKSPACE}`]);
    sessions = true;
    clients = [];
    const authService = {
      consumeRealtimeTicket: jest.fn(async (ticket) => ticket === 't'.repeat(43) && sessions
        ? { userId: 'user-1', sessionTokenHash: require('../src/auth/tokens').hashSessionToken(TOKEN) }
        : null),
      authenticateSessionHash: jest.fn(async (hash) => hash && sessions ? { id: 'user-1' } : null),
    };
    const workspaceService = {
      getWorkspaceForMember: jest.fn(async ({ workspaceId, userId }) => members.has(`${userId}:${workspaceId}`) ? { id: workspaceId } : null),
    };
    hub = createRealtimeHub({ authService, workspaceService });
    httpServer = createServer();
    socketServer = new Server(httpServer);
    hub.attach(socketServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise((resolve) => socketServer.close(resolve));
  });

  function connect(auth, origin = 'http://localhost:5173') {
    const client = createSocket(`http://127.0.0.1:${port}`, {
      auth, extraHeaders: { Origin: origin },
      transports: ['websocket'], forceNew: true, reconnection: false,
    });
    clients.push(client);
    return client;
  }

  test('requires an opaque valid session token and authorizes each workspace subscription', async () => {
    const unauthenticated = connect({});
    await expectOnce(unauthenticated, 'connect_error');

    const wrongOrigin = connect({ ticket: 't'.repeat(43) }, 'https://attacker.example');
    await expectOnce(wrongOrigin, 'connect_error');

    const client = connect({ ticket: 't'.repeat(43), workspaceId: OTHER_WORKSPACE });
    await waitFor(client, 'connect');
    const denied = await emitAck(client, 'workspace:subscribe', { workspaceId: OTHER_WORKSPACE });
    expect(denied).toEqual({ ok: false, error: 'workspace_not_found' });
    expect(await emitAck(client, 'workspace:subscribe', { workspaceId: WORKSPACE, role: 'owner' }))
      .toEqual({ ok: false, error: 'invalid_request' });
    expect(await emitAck(client, 'workspace:subscribe', { workspaceId: WORKSPACE })).toEqual({ ok: true, workspaceId: WORKSPACE });
  });

  test('delivers only sanitized workspace events and stops after membership revocation', async () => {
    const authorized = connect({ ticket: 't'.repeat(43) });
    await waitFor(authorized, 'connect');
    await emitAck(authorized, 'workspace:subscribe', { workspaceId: WORKSPACE });
    const eventPromise = waitFor(authorized, 'workspace:event');
    expect(await hub.publishWorkspaceEvent({ workspaceId: WORKSPACE, resourceType: 'task', resourceId: RESOURCE, action: 'updated', title: 'private task title' })).toBe(true);
    const event = await eventPromise;
    expect(event).toMatchObject({ workspaceId: WORKSPACE, resourceType: 'task', resourceId: RESOURCE, action: 'updated' });
    expect(Object.keys(event).sort()).toEqual(['action', 'eventId', 'occurredAt', 'resourceId', 'resourceType', 'workspaceId'].sort());

    members.delete(`user-1:${WORKSPACE}`);
    const noEvent = waitFor(authorized, 'workspace:event', 100);
    await hub.publishWorkspaceEvent({ workspaceId: WORKSPACE, resourceType: 'task', resourceId: RESOURCE, action: 'deleted' });
    await expect(noEvent).rejects.toThrow('timeout');
    expect(await emitAck(authorized, 'workspace:subscribe', { workspaceId: WORKSPACE }))
      .toEqual({ ok: false, error: 'workspace_not_found' });

    members.add(`user-1:${WORKSPACE}`);
    await emitAck(authorized, 'workspace:subscribe', { workspaceId: WORKSPACE });
    const revokedProbe = connect({ ticket: 't'.repeat(43) });
    await waitFor(revokedProbe, 'connect');
    await emitAck(revokedProbe, 'workspace:subscribe', { workspaceId: WORKSPACE });
    sessions = false;
    expect(await emitAck(revokedProbe, 'workspace:subscribe', { workspaceId: WORKSPACE }))
      .toEqual({ ok: false, error: 'authentication_required' });
    const revokedNoEvent = waitFor(authorized, 'workspace:event', 100);
    await hub.publishWorkspaceEvent({ workspaceId: WORKSPACE, resourceType: 'task', resourceId: RESOURCE, action: 'deleted' });
    await expect(revokedNoEvent).rejects.toThrow('timeout');
  });

  test('validates optional Redis configuration and leaves Redis disabled by default', () => {
    expect(readRealtimeConfig({}).enabled).toBe(false);
    expect(readRealtimeConfig({ REDIS_URL: 'rediss://cache.example:6380' }).enabled).toBe(true);
    expect(readRealtimeConfig({ REDIS_URL: 'rediss://teamvault:encoded-secret@cache.example:6380' }).enabled).toBe(true);
    expect(() => readRealtimeConfig({ REDIS_URL: 'https://not-redis.example' })).toThrow('redis:// or rediss://');
    expect(() => readRealtimeConfig({ REDIS_URL: 'https://private-secret.example' }))
      .toThrow('REDIS_URL must use redis:// or rediss:// and include a host.');
    expect(createRedisRuntime().enabled).toBe(false);
  });

  test('falls back to a per-process auth limiter when Redis is not ready', async () => {
    const store = createResilientRateLimitStore({ isReady: false });
    store.init({ windowMs: 60000 });
    await expect(store.increment('local-key')).resolves.toMatchObject({ totalHits: 1 });
    await store.shutdown();

    const failingStore = createResilientRateLimitStore({
      isReady: true,
      async sendCommand() { throw new Error('private Redis failure detail'); },
    });
    failingStore.init({ windowMs: 60000 });
    await expect(failingStore.increment('redis-error-key')).resolves.toMatchObject({ totalHits: 1 });
    await failingStore.shutdown();
  });

  test('uses locally authorized sockets when Redis adapter room lookup fails', async () => {
    let middleware;
    let onConnection;
    const room = `workspace:${WORKSPACE}`;
    const fakeSocket = {
      data: { userId: 'user-1', sessionTokenHash: require('../src/auth/tokens').hashSessionToken(TOKEN), workspaceIds: [WORKSPACE] },
      rooms: new Set([room]),
      join: jest.fn(async () => {}),
      leave: jest.fn(async () => {}),
      emit: jest.fn(),
      on: jest.fn(),
    };
    const fakeIo = {
      use(callback) { middleware = callback; },
      on(_event, callback) { onConnection = callback; },
      in() { return { async fetchSockets() { throw new Error('Redis unavailable'); } }; },
      of() { return { sockets: new Map([['socket-1', fakeSocket]]) }; },
    };
    const localHub = createRealtimeHub({
      authService: {
        consumeRealtimeTicket: async () => ({ userId: 'user-1', sessionTokenHash: require('../src/auth/tokens').hashSessionToken(TOKEN) }),
        authenticateSessionHash: async () => ({ id: 'user-1' }),
      },
      workspaceService: { getWorkspaceForMember: async () => ({ id: WORKSPACE }) },
    });
    localHub.attach(fakeIo);
    await new Promise((resolve, reject) => middleware({
      handshake: { auth: { ticket: 't'.repeat(43) }, headers: { origin: 'http://localhost:5173' } }, data: {},
    }, (error) => error ? reject(error) : resolve()));
    onConnection(fakeSocket);
    await expect(localHub.publishWorkspaceEvent({ workspaceId: WORKSPACE, resourceType: 'project', resourceId: RESOURCE, action: 'created' }))
      .resolves.toBe(true);
    expect(fakeSocket.emit).toHaveBeenCalledWith('workspace:event', expect.objectContaining({ workspaceId: WORKSPACE }));
  });

  test('tolerates Redis startup failure without making server startup fail', async () => {
    class OfflineClient extends EventEmitter {
      isOpen = false;
      isReady = false;
      duplicate() { return new OfflineClient(); }
      async connect() { this.isOpen = true; throw new Error('private broker details'); }
      async quit() { this.isOpen = false; }
      destroy() { this.isOpen = false; }
    }
    const runtime = createRedisRuntime({
      redisUrl: 'redis://cache.example:6379',
      clientFactory: () => new OfflineClient(),
    });
    await expect(runtime.start({})).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (...args) => { clearTimeout(timeout); resolve(args[0]); });
  });
}

function expectOnce(socket, event) {
  return waitFor(socket, event);
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
