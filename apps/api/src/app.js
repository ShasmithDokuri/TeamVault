const cors = require('cors');
const express = require('express');
const { googleOAuth, webOrigin } = require('./config');
const { createAuthService } = require('./auth/service');
const userRepository = require('./auth/user-repository');
const errorHandler = require('./middleware/error-handler');
const { createAuthRouter } = require('./routes/auth');
const { createWorkspaceRouter } = require('./routes/workspaces');
const healthRouter = require('./routes/health');

function createApp({ authService = createAuthService(userRepository, googleOAuth) } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      callback(null, origin === webOrigin ? origin : false);
    },
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/health', healthRouter);
  app.use('/api/auth', createAuthRouter(authService));
  app.use('/api/workspaces', createWorkspaceRouter(authService));

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);
  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
