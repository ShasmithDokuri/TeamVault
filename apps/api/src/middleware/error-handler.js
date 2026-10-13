function errorHandler(error, _request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }

  process.stderr.write("[api-error] " + (error?.stack || error?.message || String(error)) + "\n");

  if (error.code === 'SERVICE_UNAVAILABLE') {
    response.status(503).json({ error: 'Authentication service unavailable' });
    return;
  }

  if (['23503', '23001'].includes(error.code) && [
    'workspace_files_project_workspace_fk',
    'workspace_files_task_project_workspace_fk',
  ].includes(error.constraint)) {
    response.status(409).json({ error: 'Delete attached files before removing this resource.' });
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
