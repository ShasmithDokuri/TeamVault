function errorHandler(error, _request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error.code === 'SERVICE_UNAVAILABLE') {
    response.status(503).json({ error: 'Authentication service unavailable' });
    return;
  }

  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  const message = status >= 500
    ? 'Internal server error'
    : status === 413
      ? 'Request body too large'
      : 'Invalid request';

  response.status(status).json({ error: message });
}

module.exports = errorHandler;
