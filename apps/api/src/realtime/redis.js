const { createAdapter } = require('@socket.io/redis-adapter');
const { MemoryStore } = require('express-rate-limit');
const { createClient } = require('redis');
const { RedisStore } = require('rate-limit-redis');

function createResilientRateLimitStore(client) {
  const localStore = new MemoryStore();
  let rateLimitOptions;
  let remoteStore;
  let remoteInitialization;

  async function getRemoteStore() {
    if (!client?.isReady) return null;
    if (remoteStore) return remoteStore;
    if (!remoteInitialization) {
      const candidate = new RedisStore({
        prefix: 'teamvault:auth-attempts:',
        sendCommand: (...args) => client.sendCommand(args),
      });
      remoteInitialization = candidate.init(rateLimitOptions)
        .then(() => { remoteStore = candidate; return candidate; })
        .catch(() => null)
        .finally(() => { remoteInitialization = null; });
    }
    return remoteInitialization;
  }

  return {
    init(options) {
      rateLimitOptions = options;
      localStore.init(options);
    },
    async increment(key) {
      const remote = await getRemoteStore();
      if (remote) {
        try { return await remote.increment(key); } catch { remoteStore = null; }
      }
      return localStore.increment(key);
    },
    async decrement(key) {
      const remote = await getRemoteStore();
      if (remote) {
        try { return await remote.decrement(key); } catch { remoteStore = null; }
      }
      return localStore.decrement(key);
    },
    async resetKey(key) {
      const remote = await getRemoteStore();
      if (remote) {
        try { await remote.resetKey(key); } catch { remoteStore = null; }
      }
      return localStore.resetKey(key);
    },
    async get(key) {
      const remote = await getRemoteStore();
      if (remote) {
        try { return await remote.get(key); } catch { remoteStore = null; }
      }
      return localStore.get(key);
    },
    shutdown() { localStore.shutdown(); },
  };
}

function createRedisRuntime({ redisUrl = null, clientFactory = createClient, adapterFactory = createAdapter } = {}) {
  if (!redisUrl) {
    return Object.freeze({
      enabled: false,
      rateLimitStore: null,
      async start() {},
      async close() {},
    });
  }

  const options = {
    url: redisUrl,
    disableOfflineQueue: true,
    socket: { reconnectStrategy: (attempt) => Math.min(attempt * 250, 5000) },
  };
  const publisher = clientFactory(options);
  const subscriber = publisher.duplicate();
  publisher.on('error', () => {});
  subscriber.on('error', () => {});
  const rateLimitStore = createResilientRateLimitStore(publisher);
  let io;
  let adapterEnabled = false;
  let adapterChange = Promise.resolve();
  let redisUnavailable = false;

  function reportUnavailable() {
    if (redisUnavailable) return;
    redisUnavailable = true;
    process.stderr.write('Redis unavailable; using process-local rate limits and live delivery where possible.\n');
  }

  function reportReady() {
    if (!publisher.isReady || !subscriber.isReady) return;
    if (redisUnavailable) {
      process.stderr.write('Redis connection restored; shared rate limits and live delivery are available.\n');
      redisUnavailable = false;
    }
  }

  function enableAdapterWhenReady() {
    if (!io || !publisher.isReady || !subscriber.isReady || adapterEnabled) return;
    adapterEnabled = true;
    io.adapter(adapterFactory(publisher, subscriber));
    const existingSockets = [...io.of('/').sockets.values()];
    adapterChange = Promise.all(existingSockets.flatMap((socket) =>
      [
        ...(socket.data.userId ? [socket.join(`user:${socket.data.userId}`)] : []),
        ...(socket.data.workspaceIds ?? []).map((workspaceId) => socket.join(`workspace:${workspaceId}`)),
      ]))
      .catch(() => {});
  }

  publisher.on('ready', enableAdapterWhenReady);
  subscriber.on('ready', enableAdapterWhenReady);
  publisher.on('ready', reportReady);
  subscriber.on('ready', reportReady);
  publisher.on('error', reportUnavailable);
  subscriber.on('error', reportUnavailable);

  return Object.freeze({
    enabled: true,
    publisher,
    subscriber,
    rateLimitStore,
    async start(socketServer) {
      io = socketServer;
      enableAdapterWhenReady();
      for (const client of [publisher, subscriber]) {
        if (!client.isOpen) client.connect().catch(() => {});
      }
    },
    async close() {
      rateLimitStore.shutdown();
      await Promise.all([publisher, subscriber].map(async (client) => {
        try {
          if (client.isOpen) await client.quit();
          else client.destroy();
        } catch { client.destroy(); }
      }));
      await adapterChange;
    },
  });
}

module.exports = { createRedisRuntime, createResilientRateLimitStore };
