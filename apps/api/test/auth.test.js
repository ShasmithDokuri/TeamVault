const request = require('supertest');
const { createApp } = require('../src/app');

function makeService(overrides = {}) {
  return {
    isGoogleOAuthEnabled: false,
    register: jest.fn().mockResolvedValue({
      user: { id: 'user-1', email: 'person@example.com', displayName: 'Person' },
      token: 'a'.repeat(43),
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    }),
    login: jest.fn().mockResolvedValue(null),
    authenticate: jest.fn().mockResolvedValue(null),
    createRealtimeTicket: jest.fn().mockResolvedValue(null),
    logout: jest.fn().mockResolvedValue(undefined),
    beginGoogleOAuth: jest.fn(),
    completeGoogleOAuth: jest.fn(),
    recordGoogleFailure: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('authentication routes', () => {
  test('validates registration and normalizes email before creating a session', async () => {
    const authService = makeService();
    const app = createApp({ authService });

    const invalid = await request(app).post('/api/auth/register').send({ email: 'bad', password: 'short' });
    expect(invalid.status).toBe(400);
    expect(authService.register).not.toHaveBeenCalled();

    const response = await request(app).post('/api/auth/register').send({
      email: ' Person@Example.com ',
      password: 'long enough password',
      displayName: 'Person',
    });

    expect(response.status).toBe(201);
    expect(authService.register).toHaveBeenCalledWith({
      email: 'person@example.com',
      password: 'long enough password',
      displayName: 'Person',
    });
    expect(response.body.accessToken).toBe('a'.repeat(43));
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  test('uses the same safe response for all invalid login credentials', async () => {
    const app = createApp({ authService: makeService() });
    const response = await request(app).post('/api/auth/login').send({
      email: 'person@example.com',
      password: 'long enough password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid email or password.' });
  });

  test('protects the current-user route and revokes sessions at logout', async () => {
    const authService = makeService({
      authenticate: jest.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' }),
    });
    const app = createApp({ authService });

    const denied = await request(app).get('/api/auth/me');
    expect(denied.status).toBe(401);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${'b'.repeat(43)}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe('user-1');

    const logout = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${'b'.repeat(43)}`);
    expect(logout.status).toBe(204);
    expect(authService.logout).toHaveBeenCalledWith('b'.repeat(43), 'user-1');
  });

  test('issues an HttpOnly same-site browser cookie without returning the token and revokes it on logout', async () => {
    const authService = makeService({
      register: jest.fn().mockResolvedValue({
        user: { id: 'user-1', email: 'person@example.com', displayName: 'Person' },
        token: 'c'.repeat(43), expiresAt: new Date('2030-01-01T00:15:00.000Z'),
      }),
      authenticate: jest.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' }),
    });
    const app = createApp({ authService });
    const origin = 'http://localhost:5173';
    const registered = await request(app).post('/api/auth/register')
      .set('Origin', origin).set('X-TeamVault-Auth-Mode', 'cookie')
      .send({ email: 'person@example.com', password: 'long enough password' });

    expect(registered.status).toBe(201);
    expect(registered.body).not.toHaveProperty('accessToken');
    const cookie = registered.headers['set-cookie'][0];
    expect(cookie).toContain('tv_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api');
    expect(cookie).toContain('Max-Age=900');

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0]);
    expect(me.status).toBe(200);
    const logout = await request(app).post('/api/auth/logout').set('Origin', origin)
      .set('Cookie', cookie.split(';')[0]);
    expect(logout.status).toBe(204);
    expect(authService.logout).toHaveBeenCalledWith('c'.repeat(43), 'user-1');
    expect(logout.headers['set-cookie'][0]).toContain('Max-Age=0');
  });

  test('issues a short-lived realtime ticket only for an authorized same-origin cookie session', async () => {
    const authService = makeService({
      authenticate: jest.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' }),
      createRealtimeTicket: jest.fn().mockResolvedValue({ ticket: 't'.repeat(43), expiresAt: new Date('2030-01-01T00:00:30.000Z') }),
    });
    const app = createApp({ authService });
    const cookie = `tv_session=${'c'.repeat(43)}`;
    const wrongOrigin = await request(app).post('/api/auth/realtime-ticket')
      .set('Origin', 'https://attacker.example').set('Cookie', cookie);
    expect(wrongOrigin.status).toBe(403);
    expect(authService.createRealtimeTicket).not.toHaveBeenCalled();

    const bearer = await request(app).post('/api/auth/realtime-ticket')
      .set('Authorization', `Bearer ${'b'.repeat(43)}`).set('Origin', 'http://localhost:5173');
    expect(bearer.status).toBe(403);
    expect(authService.createRealtimeTicket).not.toHaveBeenCalled();

    const response = await request(app).post('/api/auth/realtime-ticket')
      .set('Origin', 'http://localhost:5173').set('Cookie', cookie);
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.ticket).toHaveLength(43);
    expect(response.body).not.toHaveProperty('accessToken');
    expect(authService.createRealtimeTicket).toHaveBeenCalledWith('c'.repeat(43));
  });

  test('rejects wrong-origin cookie login before creating a session and blocks cookie-authenticated CSRF requests', async () => {
    const authService = makeService({
      authenticate: jest.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.com' }),
    });
    const app = createApp({ authService });
    const wrongOriginLogin = await request(app).post('/api/auth/login')
      .set('Origin', 'https://attacker.example').set('X-TeamVault-Auth-Mode', 'cookie')
      .send({ email: 'person@example.com', password: 'long enough password' });
    expect(wrongOriginLogin.status).toBe(403);
    expect(authService.login).not.toHaveBeenCalled();

    const csrf = await request(app).post('/api/workspaces')
      .set('Cookie', `tv_session=${'d'.repeat(43)}`).send({ name: 'Blocked' });
    expect(csrf.status).toBe(403);
  });

  test('does not disclose internal authentication errors', async () => {
    const authService = makeService({
      login: jest.fn().mockRejectedValue(new Error('database password leaked')),
    });
    const app = createApp({ authService });
    const response = await request(app).post('/api/auth/login').send({
      email: 'person@example.com',
      password: 'long enough password',
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });

  test('sets a browser-bound cookie for Google OAuth and requires it on callback', async () => {
    const authService = makeService({
      isGoogleOAuthEnabled: true,
      googleOAuthUsesSecureCookies: true,
      beginGoogleOAuth: jest.fn().mockResolvedValue({ state: 's'.repeat(43), authorizationUrl: 'https://accounts.google.com/' }),
      completeGoogleOAuth: jest.fn(),
    });
    const app = createApp({ authService });
    const start = await request(app).get('/api/auth/google');
    expect(start.status).toBe(302);
    expect(start.headers['set-cookie'][0]).toContain('HttpOnly; SameSite=Lax');
    expect(start.headers['set-cookie'][0]).toContain('Max-Age=600');
    expect(start.headers['set-cookie'][0]).toContain('Secure');

    const callback = await request(app)
      .get(`/api/auth/google/callback?code=code&state=${'s'.repeat(43)}`)
      .set('Cookie', `tv_oauth_state=${'x'.repeat(43)}`);
    expect(callback.status).toBe(400);
    expect(authService.completeGoogleOAuth).not.toHaveBeenCalled();
    expect(callback.headers['set-cookie'][0]).toContain('Max-Age=0');
  });

  test('rate limits repeated authentication attempts', async () => {
    const app = createApp({ authService: makeService() });
    const responses = await Promise.all(Array.from({ length: 11 }, () => request(app)
      .post('/api/auth/login')
      .send({ email: 'person@example.com', password: 'long enough password' })));

    expect(responses.filter(({ status }) => status === 429)).toHaveLength(1);
  });
});
