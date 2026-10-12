const app = require('./app');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { port, webOrigin } = require('./config');

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: webOrigin, methods: ['GET', 'POST'] },
});
const runtime = app.locals.teamVaultRuntime;
runtime.realtimeHub.attach(io);
runtime.redisRuntime.start(io).catch(() => {});

async function shutdown() {
  await new Promise((resolve) => io.close(resolve));
  await runtime.redisRuntime.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

httpServer.listen(port, () => {
  process.stdout.write(`TeamVault API listening on port ${port}\n`);
});
