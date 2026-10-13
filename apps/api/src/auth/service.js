const { createHash, randomBytes } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { hashPassword, verifyPassword } = require('./passwords');
const { createSessionToken, hashSessionToken } = require('./tokens');

const SESSION_TTL_MS = 15 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function normalizeEmail(email) {
  return email.trim().normalize('NFKC').toLowerCase();
}

function hashOAuthState(state) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function createAuthService(repository, googleConfig = {}, injectedGoogleClient) {
  const googleClient = injectedGoogleClient ?? (
    googleConfig.clientId && googleConfig.clientSecret && googleConfig.redirectUri
      ? new OAuth2Client(googleConfig.clientId, googleConfig.clientSecret, googleConfig.redirectUri)
      : null
  );

  async function issueSession(user, eventType) {
    const session = createSessionToken();
    await repository.createSessionAndAudit({
      userId: user.id,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      eventType,
    });
    const { passwordHash: _passwordHash, googleSubject: _googleSubject, ...publicUser } = user;
    return { user: publicUser, ...session };
  }

  return {
    isGoogleOAuthEnabled: Boolean(googleClient),
    googleOAuthUsesSecureCookies: googleConfig.redirectUri?.startsWith('https://') ?? false,

    async register({ email, password, displayName }) {
      const passwordHash = await hashPassword(password);
      const session = createSessionToken();
      let user;
      try {
        user = await repository.createUserAndSession({
          email: normalizeEmail(email),
          displayName: displayName?.trim() || null,
          passwordHash,
          tokenHash: session.tokenHash,
          expiresAt: session.expiresAt,
        });
      } catch (error) {
        try {
          await repository.recordAuthAuditEvent({ eventType: 'registration_failure' });
        } catch {
          // Preserve the original registration error if audit storage is unavailable.
        }
        throw error;
      }
      return publicSession(user, session);
    },

    async login({ email, password }) {
      const user = await repository.findUserByEmail(normalizeEmail(email));
      if (!user || !user.passwordHash) {
        await hashPassword(password);
        await repository.recordAuthAuditEvent({ eventType: 'login_failure' });
        return null;
      }

      if (!await verifyPassword(password, user.passwordHash)) {
        await repository.recordAuthAuditEvent({ userId: user.id, eventType: 'login_failure' });
        return null;
      }
      const { passwordHash: _passwordHash, ...publicUser } = user;
      return issueSession(publicUser, 'login_success');
    },

    async authenticate(token) {
      return repository.findUserBySessionTokenHash(hashSessionToken(token));
    },

    async authenticateSessionHash(tokenHash) {
      return repository.findUserBySessionTokenHash(tokenHash);
    },

    async createRealtimeTicket(token) {
      const sessionTokenHash = hashSessionToken(token);
      const user = await repository.findUserBySessionTokenHash(sessionTokenHash);
      if (!user) return null;
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 30 * 1000);
      const created = await repository.createRealtimeTicket({
        ticketHash: hashSessionToken(ticket), sessionTokenHash, userId: user.id, expiresAt,
      });
      return created ? { ticket, expiresAt } : null;
    },

    async consumeRealtimeTicket(ticket) {
      if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return null;
      return repository.consumeRealtimeTicket(hashSessionToken(ticket));
    },

    async logout(token, userId) {
      await repository.revokeSessionAndAudit({ tokenHash: hashSessionToken(token), userId });
    },

    async beginGoogleOAuth() {
      if (!googleClient) return null;

      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const { codeVerifier, codeChallenge } = await googleClient.generateCodeVerifierAsync();
      await repository.createGoogleOAuthState({
        stateHash: hashOAuthState(state),
        nonce,
        codeVerifier,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      });

      return {
        state,
        authorizationUrl: googleClient.generateAuthUrl({
          redirect_uri: googleConfig.redirectUri,
          response_type: 'code',
          scope: ['openid', 'email', 'profile'],
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        }),
      };
    },

    async completeGoogleOAuth({ code, state }) {
      if (!googleClient) return { kind: 'disabled' };

      const oauthState = await repository.consumeGoogleOAuthState(hashOAuthState(state));
      if (!oauthState) {
        await repository.recordAuthAuditEvent({ eventType: 'google_login_failure' });
        return { kind: 'invalid_state' };
      }

      let payload;
      try {
        const { tokens } = await googleClient.getToken({
          code,
          codeVerifier: oauthState.codeVerifier,
          redirect_uri: googleConfig.redirectUri,
        });
        if (!tokens.id_token) {
          await repository.recordAuthAuditEvent({ eventType: 'google_login_failure' });
          return { kind: 'invalid_identity' };
        }

        const ticket = await googleClient.verifyIdToken({
          idToken: tokens.id_token,
          audience: googleConfig.clientId,
        });
        payload = ticket.getPayload();
      } catch {
        await repository.recordAuthAuditEvent({ eventType: 'google_login_failure' });
        return { kind: 'provider_error' };
      }

      if (
        !payload
        || !payload.sub
        || !GOOGLE_ISSUERS.has(payload.iss)
        || !payload.email
        || payload.email_verified !== true
        || payload.nonce !== oauthState.nonce
      ) {
        await repository.recordAuthAuditEvent({ eventType: 'google_login_failure' });
        return { kind: 'invalid_identity' };
      }

      const session = createSessionToken();
      const user = await repository.findOrCreateGoogleUserAndSession({
        email: normalizeEmail(payload.email),
        displayName: payload.name ?? null,
        googleSubject: payload.sub,
        tokenHash: session.tokenHash,
        expiresAt: session.expiresAt,
      });
      return { kind: 'authenticated', session: publicSession(user, session) };
    },

    async recordGoogleFailure() {
      await repository.recordAuthAuditEvent({ eventType: 'google_login_failure' });
    },
  };
}

function publicSession(user, session) {
  const { passwordHash: _passwordHash, googleSubject: _googleSubject, ...publicUser } = user;
  return { user: publicUser, ...session };
}

module.exports = { SESSION_TTL_MS, createAuthService };
