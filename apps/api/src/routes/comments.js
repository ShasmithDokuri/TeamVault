const express = require('express');
const { createRequireAuth } = require('../middleware/require-auth');
const { createCommentService } = require('../services/comments');
const { hasOnlyKeys, isUuid, validateRequiredText, validateVersion } = require('../projects/validation');

function createCommentsRouter(authService, commentService = createCommentService(), realtimeHub) {
  const router = express.Router();
  router.use(createRequireAuth(authService));

  router.post('/:workspaceId/projects/:projectId/comments', (request, response, next) =>
    createComment(request, response, next, commentService, null, realtimeHub));
  router.get('/:workspaceId/projects/:projectId/comments', (request, response, next) =>
    listComments(request, response, next, commentService, null));
  router.post('/:workspaceId/projects/:projectId/tasks/:taskId/comments', (request, response, next) =>
    createComment(request, response, next, commentService, request.params.taskId, realtimeHub));
  router.get('/:workspaceId/projects/:projectId/tasks/:taskId/comments', (request, response, next) =>
    listComments(request, response, next, commentService, request.params.taskId));

  router.patch('/:workspaceId/projects/:projectId/comments/:commentId', (request, response, next) =>
    updateComment(request, response, next, commentService, null, realtimeHub));
  router.delete('/:workspaceId/projects/:projectId/comments/:commentId', (request, response, next) =>
    deleteComment(request, response, next, commentService, null, realtimeHub));
  router.patch('/:workspaceId/projects/:projectId/tasks/:taskId/comments/:commentId', (request, response, next) =>
    updateComment(request, response, next, commentService, request.params.taskId, realtimeHub));
  router.delete('/:workspaceId/projects/:projectId/tasks/:taskId/comments/:commentId', (request, response, next) =>
    deleteComment(request, response, next, commentService, request.params.taskId, realtimeHub));

  return router;
}

async function createComment(request, response, next, repo, taskId, realtimeHub) {
  if (!validIds(request, taskId)) return notFound(response);
  if (!hasOnlyKeys(request.body, ['content'])) return invalid(response);
  const content = validateRequiredText(request.body.content, 5000);
  if (!content.valid) return invalid(response);
  try {
    const comment = await repo.createComment({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, actorId: request.auth.user.id, content: content.value,
    });
    if (!comment) return notFound(response);
    publish(realtimeHub, request.params.workspaceId, comment.id, 'created');
    return response.status(201).json({ comment });
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

async function updateComment(request, response, next, repo, taskId, realtimeHub) {
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
    publish(realtimeHub, request.params.workspaceId, result.comment.id, 'updated');
    return response.status(200).json({ comment: result.comment });
  } catch (error) { return next(error); }
}

async function deleteComment(request, response, next, repo, taskId, realtimeHub) {
  if (!validIds(request, taskId, true)) return notFound(response);
  try {
    const deleted = await repo.deleteComment({
      workspaceId: request.params.workspaceId, projectId: request.params.projectId,
      taskId, commentId: request.params.commentId, actorId: request.auth.user.id,
    });
    if (!deleted) return notFound(response);
    publish(realtimeHub, request.params.workspaceId, request.params.commentId, 'deleted');
    return response.status(204).end();
  } catch (error) { return next(error); }
}

function publish(realtimeHub, workspaceId, resourceId, action) {
  if (realtimeHub) void realtimeHub.publishWorkspaceEvent({ workspaceId, resourceType: 'comment', resourceId, action }).catch(() => {});
}

function validIds(request, taskId, hasCommentId = false) {
  return isUuid(request.params.workspaceId) && isUuid(request.params.projectId)
    && (taskId === null || isUuid(taskId))
    && (!hasCommentId || isUuid(request.params.commentId));
}
function invalid(response) { return response.status(400).json({ error: 'Invalid request.' }); }
function notFound(response) { return response.status(404).json({ error: 'Comment, project, task, or workspace not found.' }); }

module.exports = { createCommentsRouter };
