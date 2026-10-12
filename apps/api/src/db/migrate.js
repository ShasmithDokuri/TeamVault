const fs = require('node:fs/promises');
const path = require('node:path');
const { databaseUrl } = require('../config');
const { getPool } = require('./pool');

async function migrate() {
  if (!databaseUrl) {
    throw new Error('Set DATABASE_URL before running database migrations.');
  }

  const migrationsDirectory = path.join(__dirname, '../../migrations');
  const migrationFiles = (await fs.readdir(migrationsDirectory))
    .filter((filename) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(filename))
    .sort();

  for (const filename of migrationFiles) {
    const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
    await getPool().query(sql);
    process.stdout.write(`Applied ${filename}.\n`);
  }
}

migrate()
  .catch(() => {
    process.stderr.write('Database migration failed. Check DATABASE_URL and database availability.\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { getPool: getDatabasePool } = require('./pool');
      const pool = getDatabasePool();
      await pool.end();
    } catch {
      // No pool was created when DATABASE_URL is missing.
    }
  });
