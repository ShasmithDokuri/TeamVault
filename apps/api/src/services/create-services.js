const { createActivityService } = require('./activity');
const { createCommentService } = require('./comments');
const { createFileService } = require('./files');
const { createProjectService } = require('./projects');
const { createWorkspaceService } = require('./workspaces');

function createServices(repositories = {}, options = {}) {
  return Object.freeze({
    workspaces: createWorkspaceService(repositories.workspaces),
    projects: createProjectService(repositories.projects),
    comments: createCommentService(repositories.comments),
    activity: createActivityService(repositories.activity),
    files: createFileService({
      repository: repositories.files,
      objectStore: options.fileObjectStore,
      config: options.fileConfig,
    }),
  });
}

module.exports = { createServices };
