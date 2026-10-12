const express = require('express');
const { createRequireAuth } = require('../middleware/require-auth');
const repository = require('../comments/repository');
const { hasOnlyKeys, isUuid, validateRequiredText, validateVersion } = require('../projects/validation');

function createCommentsRouter(authService, commentRepository = repository) {
  const router = express.Router();
  router.use(createRequireAuth(authService));

  router.post('/:workspaceId/projects/:projectId/comments', (request, response, next) =>
    createComment(request, response, next, commentRepository, null));
  router.get('/:workspaceId/projects/:projectId/comments', (request, response, next) =>
    listComments(request, response, next, commentRepository, null));
  router.post('/:workspaceId/projects/:projectId/tasks/:taskId/comments', (request, response, next) =>
    createComment(request, response, next, commentRepository, request.params.taskId));
  router.get('/:workspaceId/projects/:projectId/tasks/:taskId/comments', (request, response, next) =>
    listComments(request, response, next, commentRepository, request.params.taskId));

  router.patch('/:workspaceId/projects/:projectId/comments/:commentId', (request, response, next) =>
    updateComment(request, response, next, commentRepository, null));
  router.delete('/:workspaceId/projects/:projectId/comments/:commentId', (request, response, next) =>
    deleteComment(request, response, next, commentRepository, null));
  router.patch('/:workspaceId/projects/:projectId/tasks/:taskId/comments/:commentId', (request, response, next) =>
    updateComment(request, response, next, commentRepository, request.params.taskId));
  router.delete('/:workspaceId/projects/:projectId/tasks/:taskId/comments/:commentId', (request, response, next) =>
    deleteComment(request, response, next, commentRepository, request.params.taskId));

  return router;
}

async function createComment(request, response, next, repo, taskId) {
  if (!validIds(request, taskId)) return notFound(response);
  if (!hasOnlyKeys(request.body, ['content'])) return invalid(response);
  const content = validateRequiredText(request.body.content, 5000);
  if (!content.valid) return invalid(response);
  try {
    const comment = await repo.createComment({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, actorId: request.auth.user.id, content: content.value,
    });
    return comment ? response.status(201).json({ comment }) : notFound(response);
  } catch (error) { return next(error); }
}

async function listComments(request, response, next, repo, taskId) {
  if (!validIds(request, taskId)) return notFound(response);
  try {
    const result = await repo.listCommentsForMember({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, actorId: request.auth.user.id,
    });
    return result.authorized ? response.status(200).json({ comments: result.comments }) : notFound(response);
  } catch (error) { return next(error); }
}

async function updateComment(request, response, next, repo, taskId) {
  if (!validIds(request, taskId, true)) return notFound(response);
  if (!hasOnlyKeys(request.body, ['content', 'version'])
    || !Object.hasOwn(request.body, 'content')
    || !validateVersion(request.body.version)) return invalid(response);
  const content = validateRequiredText(request.body.content, 5000);
  if (!content.valid) return invalid(response);
  try {
    const result = await repo.updateComment({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, commentId: request.params.commentId, actorId: request.auth.user.id,
      version: request.body.version, content: content.value,
    });
    if (result.kind === 'not_found') return notFound(response);
    if (result.kind === 'conflict') return response.status(409).json({ error: 'Comment was changed; reload it and retry.' });
    return response.status(200).json({ comment: result.comment });
  } catch (error) { return next(error); }
}

async function deleteComment(request, response, next, repo, taskId) {
  if (!validIds(request, taskId, true)) return notFound(response);
  try {
    const deleted = await repo.deleteComment({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, commentId: request.params.commentId, actorId: request.auth.user.id,
    });
    return deleted ? response.status(204).end() : notFound(response);
  } catch (error) { return next(error); }
}

function validIds(request, taskId, hasCommentId = false) {
  return isUuid(request.params.workspaceId) && isUuid(request.params.projectId)
    && (taskId === null || isUuid(taskId))
    && (!hasCommentId || isUuid(request.params.commentId));
}
function invalid(response) { return response.status(400).json({ error: 'Invalid request.' }); }
function notFound(response) { return response.status(404).json({ error: 'Comment, project, task, or workspace not found.' }); }

module.exports = { createCommentsRouter };
