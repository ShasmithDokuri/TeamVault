const { webOrigin } = require('../config');

const SESSION_COOKIE = 'tv_session';

function createRequireAuth(authService, allowedOrigin = webOrigin) {
  return async function requireAuth(request, response, next) {
    const authorization = request.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
    const cookieToken = readSessionCookie(request.get('cookie'));
    const token = match?.[1] ?? (!authorization && cookieToken ? cookieToken : null);
    const cookieAuthenticated = Boolean(token && !match && cookieToken === token);

    if (!token) {
      response.status(401).json({ error: 'Authentication required.' });
      return;
    }

    if (cookieAuthenticated && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.get('origin') !== allowedOrigin) {
        response.status(403).json({ error: 'Request origin is not allowed.' });
        return;
      }
    }

    try {
      const user = await authService.authenticate(token);
      if (!user) {
        response.status(401).json({ error: 'Authentication required.' });
        return;
      }

      request.auth = { user, token, method: cookieAuthenticated ? 'cookie' : 'bearer' };
      next();
    } catch (error) {
      next(error);
    }
  };
}

function readSessionCookie(cookieHeader = '') {
  const match = /(?:^|;\s*)tv_session=([A-Za-z0-9_-]{43})(?:;|$)/u.exec(cookieHeader);
  return match?.[1] ?? null;
}

module.exports = { SESSION_COOKIE, createRequireAuth, readSessionCookie };
