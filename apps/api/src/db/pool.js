const { Pool } = require('pg');
const { databaseUrl } = require('../config');

let pool;

function getPool() {
  if (!databaseUrl) {
    const error = new Error('Database configuration is missing.');
    error.code = 'SERVICE_UNAVAILABLE';
    throw error;
  }

  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl });
    pool.on('error', () => {
      process.stderr.write('A PostgreSQL connection failed while idle.\n');
    });
  }
  return pool;
}

async function closePool() {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

module.exports = { closePool, getPool };
