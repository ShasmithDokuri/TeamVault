const cors = require('cors');
const express = require('express');
const { googleOAuth, webOrigin } = require('./config');
const { createAuthService } = require('./auth/service');
const userRepository = require('./auth/user-repository');
const errorHandler = require('./middleware/error-handler');
const { createAuthRouter } = require('./routes/auth');
const { createWorkspaceRouter } = require('./routes/workspaces');
const { createProjectsRouter } = require('./routes/projects');
const { createCommentsRouter } = require('./routes/comments');
const { createActivityRouter } = require('./routes/activity');
const { createFilesRouter } = require('./routes/files');
const { createServices } = require('./services/create-services');
const { readFileStorageConfig } = require('./files/config');
const healthRouter = require('./routes/health');

function createApp({
  authService = createAuthService(userRepository, googleOAuth),
  services,
  fileStorageConfig = readFileStorageConfig(),
} = {}) {
  const app = express();
  const appServices = services ?? createServices({}, { fileConfig: fileStorageConfig });

  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      callback(null, origin === webOrigin ? origin : false);
    },
  }));
  app.use('/api/health', healthRouter);
  app.use('/api/workspaces', createFilesRouter(authService, appServices.files, fileStorageConfig));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/auth', createAuthRouter(authService));
  app.use('/api/workspaces', createWorkspaceRouter(authService, appServices.workspaces));
  app.use('/api/workspaces', createProjectsRouter(authService, appServices.projects));
  app.use('/api/workspaces', createCommentsRouter(authService, appServices.comments));
  app.use('/api/workspaces', createActivityRouter(authService, appServices.activity));

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);
  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
