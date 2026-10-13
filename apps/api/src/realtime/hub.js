const { randomUUID } = require('node:crypto');
const { webOrigin } = require('../config');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESOURCE_TYPES = new Set(['project', 'task', 'comment', 'member']);
const ACTIONS = new Set(['created', 'updated', 'deleted']);
const MAX_WORKSPACE_SUBSCRIPTIONS = 20;

function createRealtimeHub({ authService, workspaceService, allowedOrigin = webOrigin }) {
  let io;

  return Object.freeze({
    attach(socketServer) {
      io = socketServer;
      io.use(async (socket, next) => {
        const ticket = socket.handshake.auth?.ticket;
        socket.handshake.auth = {};
        if (socket.handshake.headers.origin !== allowedOrigin
          || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
          next(new Error('Authentication required.'));
          return;
        }
        try {
          const session = await authService.consumeRealtimeTicket(ticket);
          if (!session) {
            next(new Error('Authentication required.'));
            return;
          }
          socket.data.userId = session.userId;
          socket.data.sessionTokenHash = session.sessionTokenHash;
          socket.data.workspaceIds = [];
          socket.data.workspaceSubscriptionsPending = new Set();
          next();
        } catch {
          next(new Error('Authentication unavailable.'));
        }
      });

      io.on('connection', (socket) => {
        socket.join(`user:${socket.data.userId}`);
        socket.on('workspace:subscribe', async (payload, acknowledge) => {
          const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
          const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId.toLowerCase() : null;
          if (!payload || Object.keys(payload).some((key) => key !== 'workspaceId')
              || typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
            reply({ ok: false, error: 'invalid_request' });
            return;
          }
          if (socket.data.workspaceSubscriptionsPending.has(workspaceId)) {
            reply({ ok: false, error: 'subscription_pending' });
            return;
          }
          try {
            const activeSession = await authService.authenticateSessionHash(socket.data.sessionTokenHash);
            if (activeSession?.id !== socket.data.userId) {
              reply({ ok: false, error: 'authentication_required' });
              setImmediate(() => socket.disconnect(true));
              return;
            }
            const workspace = await workspaceService.getWorkspaceForMember({
              workspaceId, userId: socket.data.userId,
            });
            if (!workspace) {
              if (socket.data.workspaceIds.includes(workspaceId)) {
                await socket.leave(`workspace:${workspaceId}`);
                socket.data.workspaceIds = socket.data.workspaceIds.filter((id) => id !== workspaceId);
              }
              reply({ ok: false, error: 'workspace_not_found' });
              return;
            }
            if (socket.data.workspaceIds.includes(workspaceId)) {
              reply({ ok: true, workspaceId });
              return;
            }
            if (socket.data.workspaceSubscriptionsPending.has(workspaceId)) {
              reply({ ok: false, error: 'subscription_pending' });
              return;
            }
            if (socket.data.workspaceIds.length + socket.data.workspaceSubscriptionsPending.size >= MAX_WORKSPACE_SUBSCRIPTIONS) {
              reply({ ok: false, error: 'subscription_limit' });
              return;
            }
            socket.data.workspaceSubscriptionsPending.add(workspaceId);
            await socket.join(`workspace:${workspaceId}`);
            socket.data.workspaceIds.push(workspaceId);
            reply({ ok: true, workspaceId });
          } catch {
            reply({ ok: false, error: 'authorization_unavailable' });
          } finally {
            socket.data.workspaceSubscriptionsPending.delete(workspaceId);
          }
        });
        socket.on('workspace:unsubscribe', async (payload, acknowledge) => {
          const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
          const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId.toLowerCase() : null;
          if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
            reply({ ok: false, error: 'invalid_request' });
            return;
          }
          await socket.leave(`workspace:${workspaceId}`);
          socket.data.workspaceIds = socket.data.workspaceIds.filter((id) => id !== workspaceId);
          reply({ ok: true });
        });
      });
    },

    async publishWorkspaceEvent({ workspaceId, resourceType, resourceId, action }) {
      if (!io || !UUID_PATTERN.test(workspaceId ?? '') || !UUID_PATTERN.test(resourceId ?? '')
          || !RESOURCE_TYPES.has(resourceType) || !ACTIONS.has(action)) return false;
      workspaceId = workspaceId.toLowerCase();
      resourceId = resourceId.toLowerCase();
      const room = `workspace:${workspaceId}`;
      const event = Object.freeze({
        eventId: randomUUID(), workspaceId, resourceType, resourceId, action,
        occurredAt: new Date().toISOString(),
      });
      let sockets;
      try {
        sockets = await io.in(room).fetchSockets();
      } catch {
        // Redis adapter requests may fail while the broker is unavailable. Keep
        // local delivery alive; cross-instance delivery resumes after reconnect.
        sockets = [...io.of('/').sockets.values()].filter((socket) => socket.rooms.has(room));
      }
      for (const socket of sockets) {
        const activeSession = await authService.authenticateSessionHash(socket.data.sessionTokenHash).catch(() => null);
        const activeMembership = await workspaceService.getWorkspaceForMember({
          workspaceId, userId: socket.data.userId,
        }).catch(() => null);
        if (activeSession?.id !== socket.data.userId) {
          await socket.disconnect(true);
        } else if (activeMembership) {
          socket.emit('workspace:event', event);
        } else {
          await socket.leave(room);
          socket.data.workspaceIds = (socket.data.workspaceIds ?? []).filter((id) => id !== workspaceId);
        }
      }
      return true;
    },

    async disconnectUser(userId) {
      if (!io || !UUID_PATTERN.test(userId ?? '')) return;
      try {
        const sockets = await io.in(`user:${userId}`).fetchSockets();
        await Promise.all(sockets.map((socket) => socket.disconnect(true)));
      } catch { /* Realtime disconnects are best effort and never block logout persistence. */ }
    },
  });
}

module.exports = { createRealtimeHub };
