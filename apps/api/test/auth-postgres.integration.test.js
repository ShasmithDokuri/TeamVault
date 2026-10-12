const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL authentication integration', () => {
  let app;
  let pool;
  let repository;
  let service;
  let email;

  beforeAll(async () => {
    const testUrl = process.env.TEAMVAULT_TEST_DATABASE_URL;
    const parsedUrl = new URL(testUrl);
    if (parsedUrl.pathname !== '/teamvault_m3_review') {
      throw new Error('Integration tests require the isolated teamvault_m3_review database.');
    }
    process.env.DATABASE_URL = testUrl;

    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    const migration = await fs.readFile(path.join(__dirname, '../migrations/001_auth.sql'), 'utf8');
    await pool.query(migration);

    repository = require('../src/auth/user-repository');
    service = require('../src/auth/service').createAuthService(repository);
    app = require('../src/app').createApp({ authService: service });
    email = `milestone3-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('registers, logs in, authenticates, expires, revokes, and rolls back an account/session atomically', async () => {
    const request = require('supertest');
    const register = await request(app).post('/api/auth/register').send({
      email,
      password: 'a real database integration password',
    });
    expect(register.status).toBe(201);
    const token = register.body.accessToken;
    const userId = register.body.user.id;

    const wrongPassword = await request(app).post('/api/auth/login').send({
      email,
      password: 'a different integration password',
    });
    expect(wrongPassword.status).toBe(401);

    const login = await request(app).post('/api/auth/login').send({
      email,
      password: 'a real database integration password',
    });
    expect(login.status).toBe(200);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    const { createSessionToken, hashSessionToken } = require('../src/auth/tokens');
    const expired = createSessionToken();
    await repository.createSession({
      userId,
      tokenHash: expired.tokenHash,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service.authenticate(expired.token)).toBeNull();

    const logout = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(204);
    const afterLogout = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(afterLogout.status).toBe(401);

    const duplicate = await request(app).post('/api/auth/register').send({
      email,
      password: 'another sufficiently long password',
    });
    expect(duplicate.status).toBe(409);

    const auditEvents = await pool.query(
      'SELECT event_type FROM auth_audit_events WHERE user_id = $1 ORDER BY id',
      [userId],
    );
    expect(auditEvents.rows.map(({ event_type }) => event_type)).toEqual([
      'registration_success', 'login_failure', 'login_success', 'logout',
    ]);
    const failedRegistration = await pool.query(
      "SELECT event_type FROM auth_audit_events WHERE user_id IS NULL AND event_type = 'registration_failure' ORDER BY id DESC LIMIT 1",
    );
    expect(failedRegistration.rowCount).toBe(1);

    const collidingSessionToken = createSessionToken();
    await expect(repository.createUserAndSession({
      email: `rollback-${email}`,
      passwordHash: 'scrypt-placeholder',
      tokenHash: hashSessionToken(login.body.accessToken),
      expiresAt: collidingSessionToken.expiresAt,
    })).rejects.toMatchObject({ name: 'DuplicateAccountError' });
    const rolledBack = await pool.query('SELECT id FROM users WHERE email = $1', [`rollback-${email}`]);
    expect(rolledBack.rowCount).toBe(0);
  }, 30000);

  test('consumes OAuth state once and rejects expired state', async () => {
    const { createHash, randomBytes } = require('node:crypto');
    const rawState = randomBytes(32).toString('base64url');
    const stateHash = createHash('sha256').update(rawState).digest('hex');
    const state = { stateHash, nonce: 'nonce', codeVerifier: 'verifier', expiresAt: new Date(Date.now() + 60000) };
    await repository.createGoogleOAuthState(state);
    expect(await repository.consumeGoogleOAuthState(stateHash)).toMatchObject({ nonce: 'nonce', code_verifier: 'verifier' });
    expect(await repository.consumeGoogleOAuthState(stateHash)).toBeNull();

    const expiredState = randomBytes(32).toString('base64url');
    const expiredHash = createHash('sha256').update(expiredState).digest('hex');
    await repository.createGoogleOAuthState({ ...state, stateHash: expiredHash, expiresAt: new Date(Date.now() - 1000) });
    expect(await repository.consumeGoogleOAuthState(expiredHash)).toBeNull();
  });

  test('links Google identities and creates their sessions atomically', async () => {
    const { createSessionToken } = require('../src/auth/tokens');
    const googleEmail = `google-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
    const firstSession = createSessionToken();
    const firstUser = await repository.findOrCreateGoogleUserAndSession({
      email: googleEmail,
      displayName: 'Google User',
      googleSubject: `subject-${Date.now()}`,
      tokenHash: firstSession.tokenHash,
      expiresAt: firstSession.expiresAt,
    });

    const secondSession = createSessionToken();
    const secondUser = await repository.findOrCreateGoogleUserAndSession({
      email: googleEmail,
      displayName: 'Updated Name',
      googleSubject: (await pool.query('SELECT google_subject FROM users WHERE id = $1', [firstUser.id])).rows[0].google_subject,
      tokenHash: secondSession.tokenHash,
      expiresAt: secondSession.expiresAt,
    });
    expect(secondUser.id).toBe(firstUser.id);

    const conflictingSession = createSessionToken();
    await expect(repository.findOrCreateGoogleUserAndSession({
      email: googleEmail,
      displayName: 'Attacker',
      googleSubject: 'different-subject',
      tokenHash: conflictingSession.tokenHash,
      expiresAt: conflictingSession.expiresAt,
    })).rejects.toBeInstanceOf(repository.DuplicateAccountError);
    const sessions = await pool.query('SELECT token_hash FROM auth_sessions WHERE token_hash = $1', [conflictingSession.tokenHash]);
    expect(sessions.rowCount).toBe(0);
    const googleAudits = await pool.query(
      "SELECT event_type FROM auth_audit_events WHERE user_id = $1 AND event_type = 'google_login_success'",
      [firstUser.id],
    );
    expect(googleAudits.rowCount).toBe(2);
  });
});
