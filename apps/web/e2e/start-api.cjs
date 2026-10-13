const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { connectToTestDatabase } = require('./test-database.cjs');

async function main() {
  const testUrl = process.env.TEAMVAULT_TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testUrl;
  process.env.COOKIE_SECURE = 'false';
  process.env.WEB_ORIGIN = process.env.TEAMVAULT_E2E_WEB_ORIGIN || 'http://127.0.0.1:4173';
  process.env.PORT = process.env.TEAMVAULT_E2E_API_PORT || '3317';

  const migrationPool = await connectToTestDatabase(testUrl);
  try {
    const migrationsDirectory = path.resolve(__dirname, '../../api/migrations');
    const files = (await fs.readdir(migrationsDirectory))
      .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    for (const name of files) {
      await migrationPool.query(await fs.readFile(path.join(migrationsDirectory, name), 'utf8'));
    }
  } finally {
    await migrationPool.end();
  }

  const { createAuthService } = require('../../api/src/auth/service');
  const userRepository = require('../../api/src/auth/user-repository');
  const { createServices } = require('../../api/src/services/create-services');
  const files = new Map();
  const objectStore = {
    async put({ key, body, contentType }) { files.set(key, { body: Buffer.from(body), contentType }); },
    async get({ key }) {
      const value = files.get(key);
      if (!value) throw new Error('File not found.');
      return { Body: Readable.from(value.body) };
    },
    async delete({ key }) { files.delete(key); },
  };
  const fileStorageConfig = { enabled: true, maxFileBytes: 10 * 1024 * 1024, maxConcurrentUploads: 4 };
  const authService = createAuthService(userRepository);
  const services = createServices({}, { fileObjectStore: objectStore, fileConfig: fileStorageConfig });
  const { createApp } = require('../../api/src/app');
  const app = createApp({ authService, services, fileStorageConfig });
  const { createServer } = require('node:http');
  const { Server } = require('socket.io');
  const server = createServer(app);
  const io = new Server(server, { cors: { origin: process.env.WEB_ORIGIN, credentials: true } });
  app.locals.teamVaultRuntime.realtimeHub.attach(io);
  server.listen(Number(process.env.PORT), '127.0.0.1', () => {
    process.stdout.write('TeamVault browser-test API is ready.\n');
  });

  let closing;
  async function shutdown() {
    if (closing) return closing;
    closing = (async () => {
      await new Promise((resolve) => io.close(resolve));
      await require('../../api/src/db/pool').closePool();
    })();
    return closing;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { shutdown().catch(() => { process.exitCode = 1; }); });
  }
}

main().catch(() => {
  process.stderr.write('Browser-test API could not start. Verify the isolated local test database and migration state.\n');
  process.exitCode = 1;
});
