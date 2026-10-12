const app = require('./app');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { port, webOrigin } = require('./config');
const { closePool } = require('./db/pool');

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: webOrigin, methods: ['GET', 'POST'] },
});
const runtime = app.locals.teamVaultRuntime;
runtime.realtimeHub.attach(io);
runtime.redisRuntime.start(io).catch(() => {});

let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await new Promise((resolve) => io.close(resolve));
    const results = await Promise.allSettled([
      runtime.redisRuntime.close(),
      closePool(),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('One or more API resources did not close cleanly.');
    }
  })();
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown().catch(() => {
      process.stderr.write('TeamVault API shutdown did not complete cleanly.\n');
      process.exitCode = 1;
    });
  });
}

httpServer.listen(port, () => {
  process.stdout.write(`TeamVault API listening on port ${port}\n`);
});
