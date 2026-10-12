function errorHandler(error, _request, response, next) {
  if (response.headersSent) {
    next(error);
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
