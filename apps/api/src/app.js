const cors = require('cors');
const express = require('express');
const { cookieSecure, googleOAuth, webOrigin } = require('./config');
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
const { readRealtimeConfig } = require('./realtime/config');
const { createRedisRuntime } = require('./realtime/redis');
const { createRealtimeHub } = require('./realtime/hub');

function createApp({
  authService = createAuthService(userRepository, googleOAuth),
  services,
  fileStorageConfig = readFileStorageConfig(),
  realtimeHub: providedRealtimeHub,
  redisRuntime: providedRedisRuntime,
} = {}) {
  const app = express();
  const appServices = services ?? createServices({}, { fileConfig: fileStorageConfig });
  const redisRuntime = providedRedisRuntime ?? createRedisRuntime(readRealtimeConfig());
  const realtimeHub = providedRealtimeHub ?? createRealtimeHub({ authService, workspaceService: appServices.workspaces });

  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      callback(null, origin === webOrigin ? origin : false);
    },
  }));
  app.use('/api/health', healthRouter);
  app.use('/api/workspaces', createFilesRouter(authService, appServices.files, fileStorageConfig));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/auth', createAuthRouter(authService, {
    rateLimitStore: redisRuntime.rateLimitStore,
    realtimeHub,
    cookieSecure,
  }));
  app.use('/api/workspaces', createWorkspaceRouter(authService, appServices.workspaces));
  app.use('/api/workspaces', createProjectsRouter(authService, appServices.projects, realtimeHub));
  app.use('/api/workspaces', createCommentsRouter(authService, appServices.comments, realtimeHub));
  app.use('/api/workspaces', createActivityRouter(authService, appServices.activity));

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);
  app.locals.teamVaultRuntime = { realtimeHub, redisRuntime };
  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
