const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { createRequireAuth } = require('../middleware/require-auth');
const { DuplicateAccountError } = require('../auth/user-repository');
const { validateCredentials } = require('../auth/validation');
const { SESSION_COOKIE } = require('../middleware/require-auth');
const { SESSION_TTL_SECONDS } = require('../auth/tokens');
const { webOrigin } = require('../config');

function createAuthRouter(authService, { rateLimitStore, realtimeHub, cookieSecure } = {}) {
  const router = express.Router();
  const requireAuth = createRequireAuth(authService);
  const authAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    ...(rateLimitStore ? { store: rateLimitStore } : {}),
    passOnStoreError: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' },
  });

  router.post('/register', requireBrowserOrigin, authAttemptLimiter, async (request, response, next) => {
    const validation = validateCredentials(request.body, { registration: true });
    if (!validation.value) return response.status(400).json({ error: validation.error });

    try {
      const result = await authService.register(validation.value);
      return sendSession(request, response, result, 201, cookieSecure);
    } catch (error) {
      if (error instanceof DuplicateAccountError || error.code === '23505') {
        return response.status(409).json({ error: 'Unable to create an account with those details.' });
      }
      return next(error);
    }
  });

  router.post('/login', requireBrowserOrigin, authAttemptLimiter, async (request, response, next) => {
    const validation = validateCredentials(request.body);
    if (!validation.value) return response.status(400).json({ error: validation.error });

    try {
      const result = await authService.login(validation.value);
      if (!result) return response.status(401).json({ error: 'Invalid email or password.' });
      return sendSession(request, response, result, 200, cookieSecure);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', requireAuth, (request, response) => {
    response.status(200).json({ user: request.auth.user });
  });

  router.post('/realtime-ticket', requireAuth, async (request, response, next) => {
    if (request.auth.method !== 'cookie') {
      return response.status(403).json({ error: 'Browser session required.' });
    }
    try {
      const result = await authService.createRealtimeTicket(request.auth.token);
      if (!result) return response.status(401).json({ error: 'Authentication required.' });
      response.set('Cache-Control', 'no-store');
      return response.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', requireAuth, async (request, response, next) => {
    try {
      await authService.logout(request.auth.token, request.auth.user.id);
      if (realtimeHub) void realtimeHub.disconnectUser(request.auth.user.id).catch(() => {});
      if (request.auth.method === 'cookie') response.set('Set-Cookie', sessionCookie('', 0, cookieSecure));
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/google', authAttemptLimiter, async (_request, response, next) => {
    if (!authService.isGoogleOAuthEnabled) {
      return response.status(503).json({ error: 'Google sign-in is not configured.' });
    }

    try {
      const { authorizationUrl, state } = await authService.beginGoogleOAuth();
      response.set('Cache-Control', 'no-store');
      response.set('Referrer-Policy', 'no-referrer');
      response.set('Set-Cookie', oauthStateCookie(state, 600, authService.googleOAuthUsesSecureCookies));
      return response.redirect(302, authorizationUrl);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/google/callback', authAttemptLimiter, async (request, response, next) => {
    const { code, state, error: providerError } = request.query;
    const browserState = readOAuthStateCookie(request.get('cookie'));
    response.set('Cache-Control', 'no-store');
    response.set('Referrer-Policy', 'no-referrer');
    response.set('Set-Cookie', oauthStateCookie('', 0, authService.googleOAuthUsesSecureCookies));
    if (
      providerError
      || typeof code !== 'string'
      || typeof state !== 'string'
      || !browserState
      || !sameState(state, browserState)
    ) {
      await authService.recordGoogleFailure();
      return response.status(400).json({ error: 'Google sign-in could not be completed.' });
    }

    try {
      const result = await authService.completeGoogleOAuth({ code, state });
      if (result.kind === 'disabled') {
        return response.status(503).json({ error: 'Google sign-in is not configured.' });
      }
      if (result.kind === 'invalid_state' || result.kind === 'invalid_identity') {
        return response.status(401).json({ error: 'Google sign-in could not be verified.' });
      }
      if (result.kind === 'provider_error') {
        return response.status(502).json({ error: 'Google sign-in is temporarily unavailable.' });
      }
      return response.status(200).json(sessionResponse(result.session));
    } catch (error) {
      if (error instanceof DuplicateAccountError || error.code === '23505') {
        await authService.recordGoogleFailure();
        return response.status(409).json({ error: 'Unable to link this Google account.' });
      }
      return next(error);
    }
  });

  return router;
}

function oauthStateCookie(state, maxAge = 600, secure = process.env.NODE_ENV === 'production') {
  const parts = [
    `tv_oauth_state=${encodeURIComponent(state)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/api/auth/google/callback',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readOAuthStateCookie(cookieHeader = '') {
  const match = /(?:^|;\s*)tv_oauth_state=([A-Za-z0-9_-]{43})(?:;|$)/u.exec(cookieHeader);
  return match?.[1] ?? null;
}

function sameState(first, second) {
  const left = Buffer.from(first, 'utf8');
  const right = Buffer.from(second, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionResponse({ user, token, expiresAt }) {
  return {
    user,
    accessToken: token,
    tokenType: 'Bearer',
    expiresAt: expiresAt.toISOString(),
  };
}

function sendSession(request, response, session, status, cookieSecure) {
  if (request.get('x-teamvault-auth-mode') === 'cookie') {
    response.set({
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(session.token, SESSION_TTL_SECONDS, cookieSecure),
    });
    return response.status(status).json({ user: session.user, expiresAt: session.expiresAt.toISOString() });
  }
  return response.status(status).json(sessionResponse(session));
}

function requireBrowserOrigin(request, response, next) {
  if (request.get('x-teamvault-auth-mode') === 'cookie' && request.get('origin') !== webOrigin) {
    return response.status(403).json({ error: 'Request origin is not allowed.' });
  }
  return next();
}

function sessionCookie(token, maxAge, secure = false) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/api',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { createAuthRouter, sessionCookie };
