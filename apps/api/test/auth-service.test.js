const { createAuthService } = require('../src/auth/service');
const { OAuth2Client } = require('google-auth-library');
const { generateKeyPairSync, sign } = require('node:crypto');

describe('authentication service', () => {
  test('stores only a scrypt password hash and only a hash of the session token', async () => {
    const repository = {
      createUserAndSession: jest.fn(async ({ email, passwordHash }) => ({
        id: 'user-1', email, displayName: null, passwordHash,
      })),
      recordAuthAuditEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = createAuthService(repository);

    const result = await service.register({
      email: 'PERSON@example.com',
      password: 'a sufficiently long password',
      displayName: null,
    });

    const storedHash = repository.createUserAndSession.mock.calls[0][0].passwordHash;
    expect(storedHash).toMatch(/^scrypt\$131072\$8\$1\$/u);
    expect(storedHash).not.toContain('a sufficiently long password');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
    expect(repository.createUserAndSession.mock.calls[0][0].tokenHash).not.toBe(result.token);
    expect(repository.createUserAndSession.mock.calls[0][0].tokenHash).toHaveLength(64);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 16 * 60 * 1000);
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  test('authenticates the correct password and rejects incorrect passwords', async () => {
    const repository = {
      createUserAndSession: jest.fn(async ({ email, passwordHash }) => ({ id: 'u1', email, passwordHash })),
      createSessionAndAudit: jest.fn().mockResolvedValue(undefined),
      recordAuthAuditEvent: jest.fn().mockResolvedValue(undefined),
      findUserByEmail: jest.fn(),
    };
    const service = createAuthService(repository);
    await service.register({ email: 'person@example.com', password: 'a sufficiently long password' });
    repository.findUserByEmail.mockResolvedValue(repository.createUserAndSession.mock.results[0].value);

    const valid = await service.login({ email: 'PERSON@example.com', password: 'a sufficiently long password' });
    const invalid = await service.login({ email: 'person@example.com', password: 'a different long password' });

    expect(valid.user.email).toBe('person@example.com');
    expect(valid.user).not.toHaveProperty('passwordHash');
    expect(invalid).toBeNull();
    expect(repository.createSessionAndAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_success' }));
    expect(repository.recordAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'login_failure' }));
  });

  test('issues short-lived realtime tickets bound to active sessions and stores only hashes', async () => {
    const repository = {
      findUserBySessionTokenHash: jest.fn().mockResolvedValue({ id: 'user-1' }),
      createRealtimeTicket: jest.fn().mockResolvedValue(true),
      consumeRealtimeTicket: jest.fn().mockResolvedValue({ userId: 'user-1', sessionTokenHash: 'f'.repeat(64) }),
    };
    const service = createAuthService(repository);
    const token = 's'.repeat(43);
    const result = await service.createRealtimeTicket(token);
    const saved = repository.createRealtimeTicket.mock.calls[0][0];
    expect(result.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.ticket).not.toBe(token);
    expect(saved.ticketHash).toHaveLength(64);
    expect(saved.ticketHash).not.toBe(result.ticket);
    expect(saved.sessionTokenHash).not.toBe(token);
    expect(saved.userId).toBe('user-1');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 31_000);
    await expect(service.consumeRealtimeTicket(result.ticket)).resolves.toMatchObject({ userId: 'user-1' });
    expect(repository.consumeRealtimeTicket).toHaveBeenCalledWith(expect.any(String));
    await expect(service.consumeRealtimeTicket('invalid')).resolves.toBeNull();
    expect(repository.consumeRealtimeTicket).toHaveBeenCalledTimes(1);
  });

  test('uses OAuth state, PKCE, nonce, and verified Google identity before session creation', async () => {
    const repository = {
      createGoogleOAuthState: jest.fn().mockResolvedValue(undefined),
      consumeGoogleOAuthState: jest.fn().mockResolvedValue({ nonce: 'expected-nonce', codeVerifier: 'verifier' }),
      findOrCreateGoogleUserAndSession: jest.fn().mockResolvedValue({ id: 'google-user', email: 'g@example.com' }),
      recordAuthAuditEvent: jest.fn().mockResolvedValue(undefined),
    };
    const googleClient = {
      generateCodeVerifierAsync: jest.fn().mockResolvedValue({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
      generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?state=x'),
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'signed-id-token' } }),
      verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({
        sub: 'google-subject', email: 'g@example.com', email_verified: true,
        iss: 'https://accounts.google.com', nonce: 'expected-nonce', name: 'Google User',
      }) }),
    };
    const service = createAuthService(repository, {
      clientId: 'client-id', clientSecret: 'secret', redirectUri: 'http://localhost/callback',
    }, googleClient);

    await service.beginGoogleOAuth();
    const state = repository.createGoogleOAuthState.mock.calls[0][0];
    expect(state.stateHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(state.nonce).toHaveLength(43);
    expect(googleClient.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({
      code_challenge: 'challenge', code_challenge_method: 'S256', nonce: state.nonce,
    }));
    expect(state.stateHash).toBe(require('node:crypto').createHash('sha256').update(
      googleClient.generateAuthUrl.mock.calls[0][0].state,
    ).digest('hex'));

    const result = await service.completeGoogleOAuth({ code: 'one-time-code', state: 'raw-state' });
    expect(result.kind).toBe('authenticated');
    expect(repository.consumeGoogleOAuthState).toHaveBeenCalledWith(expect.any(String));
    expect(googleClient.getToken).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: 'verifier' }));
    expect(repository.findOrCreateGoogleUserAndSession).toHaveBeenCalledWith({
      email: 'g@example.com', displayName: 'Google User', googleSubject: 'google-subject',
      tokenHash: expect.any(String), expiresAt: expect.any(Date),
    });
  });

  test('rejects an unverified Google identity', async () => {
    const repository = {
      consumeGoogleOAuthState: jest.fn().mockResolvedValue({ nonce: 'expected', codeVerifier: 'v' }),
      recordAuthAuditEvent: jest.fn().mockResolvedValue(undefined),
    };
    const googleClient = {
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'id' } }),
      verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => ({
        sub: 'sub', email: 'person@example.com', email_verified: false, nonce: 'expected',
        iss: 'https://accounts.google.com',
      }) }),
    };
    const service = createAuthService(repository, { clientId: 'id', clientSecret: 'secret', redirectUri: 'uri' }, googleClient);

    expect(await service.completeGoogleOAuth({ code: 'c', state: 's' })).toEqual({ kind: 'invalid_identity' });
  });

  test('treats signature, issuer, expiry, and audience failures from Google as provider verification errors', async () => {
    const repository = {
      consumeGoogleOAuthState: jest.fn().mockResolvedValue({ nonce: 'expected', codeVerifier: 'v' }),
      recordAuthAuditEvent: jest.fn().mockResolvedValue(undefined),
    };
    const googleClient = {
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'untrusted-token' } }),
      verifyIdToken: jest.fn().mockRejectedValue(new Error('invalid issuer')),
    };
    const service = createAuthService(repository, { clientId: 'expected-client', clientSecret: 'secret', redirectUri: 'https://app.example/api/auth/google/callback' }, googleClient);

    expect(await service.completeGoogleOAuth({ code: 'c', state: 's' })).toEqual({ kind: 'provider_error' });
    expect(googleClient.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'untrusted-token', audience: 'expected-client',
    });
  });

  test('Google ID token verifier checks real signatures, issuer, expiry, and audience', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const client = new OAuth2Client('expected-client');
    const makeToken = (claims, key = privateKey) => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'review-key', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
      return `${signingInput}.${signature}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://accounts.google.com',
      aud: 'expected-client',
      sub: 'subject',
      iat: now,
      exp: now + 600,
    };
    const certificates = { 'review-key': publicKey.export({ type: 'spki', format: 'pem' }) };

    await expect(client.verifySignedJwtWithCertsAsync(
      makeToken(claims), certificates, 'expected-client', client.issuers,
    )).resolves.toBeDefined();
    await expect(client.verifySignedJwtWithCertsAsync(
      makeToken({ ...claims, iss: 'https://attacker.example' }), certificates, 'expected-client', client.issuers,
    )).rejects.toThrow(/Invalid issuer/u);
    await expect(client.verifySignedJwtWithCertsAsync(
      makeToken({ ...claims, aud: 'wrong-client' }), certificates, 'expected-client', client.issuers,
    )).rejects.toThrow(/Wrong recipient/u);
    await expect(client.verifySignedJwtWithCertsAsync(
      makeToken({ ...claims, exp: now - 3600 }), certificates, 'expected-client', client.issuers,
    )).rejects.toThrow(/too late/u);
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(client.verifySignedJwtWithCertsAsync(
      makeToken(claims, otherKey), certificates, 'expected-client', client.issuers,
    )).rejects.toThrow(/Invalid token signature/u);
  });
});
