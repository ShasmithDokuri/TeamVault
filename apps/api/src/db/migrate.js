const fs = require('node:fs/promises');
const path = require('node:path');
const { databaseUrl } = require('../config');
const { getPool } = require('./pool');

async function migrate() {
  if (!databaseUrl) {
    throw new Error('Set DATABASE_URL before running database migrations.');
  }

  const migrationPath = path.join(__dirname, '../../migrations/001_auth.sql');
  const sql = await fs.readFile(migrationPath, 'utf8');
  await getPool().query(sql);
  process.stdout.write('Authentication schema is up to date.\n');
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
