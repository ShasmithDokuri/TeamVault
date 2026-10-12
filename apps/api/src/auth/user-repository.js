const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');

class DuplicateAccountError extends Error {
  constructor() {
    super('Duplicate account.');
    this.name = 'DuplicateAccountError';
  }
}

function mapUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name ?? null };
}

async function createUserAndSession({ email, displayName = null, passwordHash, tokenHash, expiresAt }) {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, display_name',
        [randomUUID(), email, displayName, passwordHash],
      );
      const user = mapUser(rows[0]);
      await insertSession(client, { userId: user.id, tokenHash, expiresAt });
      await insertAuditEvent(client, { userId: user.id, eventType: 'registration_success' });
      return user;
    });
  } catch (error) {
    if (error.code === '23505') throw new DuplicateAccountError();
    throw error;
  }
}

async function findUserByEmail(email) {
  const { rows } = await getPool().query(
    'SELECT id, email, display_name, password_hash FROM users WHERE email = $1 LIMIT 1',
    [email],
  );
  if (!rows[0]) return null;
  return { ...mapUser(rows[0]), passwordHash: rows[0].password_hash };
}

async function createSession({ userId, tokenHash, expiresAt }) {
  await insertSession(getPool(), { userId, tokenHash, expiresAt });
}

async function createSessionAndAudit({ userId, tokenHash, expiresAt, eventType }) {
  await withTransaction(async (client) => {
    await insertSession(client, { userId, tokenHash, expiresAt });
    await insertAuditEvent(client, { userId, eventType });
  });
}

async function recordAuthAuditEvent({ userId = null, eventType }) {
  await insertAuditEvent(getPool(), { userId, eventType });
}

async function revokeSessionAndAudit({ tokenHash, userId }) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
    await insertAuditEvent(client, { userId, eventType: 'logout' });
  });
}

async function insertAuditEvent(client, { userId = null, eventType }) {
  await client.query(
    'INSERT INTO auth_audit_events (user_id, event_type) VALUES ($1, $2)',
    [userId, eventType],
  );
}

async function insertSession(client, { userId, tokenHash, expiresAt }) {
  await client.query(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, userId, expiresAt],
  );
}

async function findUserBySessionTokenHash(tokenHash) {
  const { rows } = await getPool().query(
    'SELECT users.id, users.email, users.display_name FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > NOW() LIMIT 1',
    [tokenHash],
  );
  return mapUser(rows[0]);
}

async function createGoogleOAuthState({ stateHash, nonce, codeVerifier, expiresAt }) {
  const pool = getPool();
  await pool.query('DELETE FROM google_oauth_states WHERE expires_at <= NOW()');
  await pool.query(
    'INSERT INTO google_oauth_states (state_hash, nonce, code_verifier, expires_at) VALUES ($1, $2, $3, $4)',
    [stateHash, nonce, codeVerifier, expiresAt],
  );
}

async function consumeGoogleOAuthState(stateHash) {
  const { rows } = await getPool().query(
    'DELETE FROM google_oauth_states WHERE state_hash = $1 AND expires_at > NOW() RETURNING nonce, code_verifier',
    [stateHash],
  );
  return rows[0] ?? null;
}

async function findOrCreateGoogleUserAndSession({ email, displayName, googleSubject, tokenHash, expiresAt }) {
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (id, email, display_name, google_subject)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
         SET google_subject = COALESCE(users.google_subject, EXCLUDED.google_subject),
             display_name = COALESCE(users.display_name, EXCLUDED.display_name)
         WHERE users.google_subject IS NULL OR users.google_subject = EXCLUDED.google_subject
         RETURNING id, email, display_name`,
        [randomUUID(), email, displayName, googleSubject],
      );
      if (!rows[0]) throw new DuplicateAccountError();
      const user = mapUser(rows[0]);
      await insertSession(client, { userId: user.id, tokenHash, expiresAt });
      await insertAuditEvent(client, { userId: user.id, eventType: 'google_login_success' });
      return user;
    });
  } catch (error) {
    if (error.code === '23505') throw new DuplicateAccountError();
    throw error;
  }
}

async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DuplicateAccountError,
  consumeGoogleOAuthState,
  createGoogleOAuthState,
  createSession,
  createSessionAndAudit,
  createUserAndSession,
  findOrCreateGoogleUserAndSession,
  findUserByEmail,
  findUserBySessionTokenHash,
  recordAuthAuditEvent,
  revokeSessionAndAudit,
};
