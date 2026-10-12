const { createActivityService } = require('./activity');
const { createCommentService } = require('./comments');
const { createProjectService } = require('./projects');
const { createWorkspaceService } = require('./workspaces');

function createServices(repositories = {}) {
  return Object.freeze({
    workspaces: createWorkspaceService(repositories.workspaces),
    projects: createProjectService(repositories.projects),
    comments: createCommentService(repositories.comments),
    activity: createActivityService(repositories.activity),
  });
}

module.exports = { createServices };
