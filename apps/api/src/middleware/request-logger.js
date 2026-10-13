const { randomUUID } = require('node:crypto');

function createRequestLogger({ writeLog = process.stdout.write.bind(process.stdout), enabled = process.env.NODE_ENV !== 'test' } = {}) {
  return (request, response, next) => {
    if (!enabled) return next();

    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => {
      const route = request.route?.path;
      const routeName = typeof route === 'string'
        ? `${request.baseUrl}${route}`
        : 'unmatched';
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      writeLog(`${JSON.stringify({
        event: 'http_request',
        requestId,
        method: request.method,
        route: routeName,
        status: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      })}\n`);
    });
    next();
  };
}

module.exports = { createRequestLogger };
