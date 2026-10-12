function createRequireAuth(authService) {
  return async function requireAuth(request, response, next) {
    const authorization = request.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);

    if (!match) {
      response.status(401).json({ error: 'Authentication required.' });
      return;
    }

    try {
      const user = await authService.authenticate(match[1]);
      if (!user) {
        response.status(401).json({ error: 'Authentication required.' });
        return;
      }

      request.auth = { user, token: match[1] };
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createRequireAuth };
