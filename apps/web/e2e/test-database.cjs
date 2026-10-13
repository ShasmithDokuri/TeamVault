const { Pool } = require('pg');

function assertDedicatedLocalUrl(value) {
  if (!value) throw new Error('Set TEAMVAULT_TEST_DATABASE_URL to the dedicated local test database before running browser tests.');
  const url = new URL(value);
  if (url.pathname !== '/teamvault_m3_review'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Browser tests are restricted to the local teamvault_m3_review database.');
  }
  return value;
}

async function connectToTestDatabase(value = process.env.TEAMVAULT_TEST_DATABASE_URL) {
  const connectionString = assertDedicatedLocalUrl(value);
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const { rows } = await pool.query('SELECT current_database() AS database_name');
    if (rows[0]?.database_name !== 'teamvault_m3_review') {
      throw new Error('The PostgreSQL server did not connect to the dedicated browser-test database.');
    }
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

module.exports = { assertDedicatedLocalUrl, connectToTestDatabase };
