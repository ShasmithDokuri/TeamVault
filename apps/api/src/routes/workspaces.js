const express = require('express');
const { createRequireAuth } = require('../middleware/require-auth');
const workspaceRepository = require('../workspaces/repository');
const { isAssignableRole, isUuid, validateWorkspaceName } = require('../workspaces/validation');

function createWorkspaceRouter(authService, repository = workspaceRepository) {
  const router = express.Router();
  router.use(createRequireAuth(authService));

  router.post('/', async (request, response, next) => {
    const name = validateWorkspaceName(request.body?.name);
    if (!name) return response.status(400).json({ error: 'Workspace name must be 1 to 100 characters.' });

    try {
      const workspace = await repository.createWorkspaceForUser({ userId: request.auth.user.id, name });
      return response.status(201).json({ workspace });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    try {
      const workspaces = await repository.listWorkspacesForUser(request.auth.user.id);
      return response.status(200).json({ workspaces });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:workspaceId', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    try {
      const workspace = await repository.getWorkspaceForMember({
        workspaceId: request.params.workspaceId,
        userId: request.auth.user.id,
      });
      return workspace ? response.status(200).json({ workspace }) : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:workspaceId', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    const name = validateWorkspaceName(request.body?.name);
    if (!name) return response.status(400).json({ error: 'Workspace name must be 1 to 100 characters.' });

    try {
      const workspace = await repository.updateWorkspaceForManager({
        workspaceId: request.params.workspaceId,
        userId: request.auth.user.id,
        name,
      });
      return workspace ? response.status(200).json({ workspace }) : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:workspaceId', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    try {
      const deleted = await repository.deleteWorkspaceForOwner({
        workspaceId: request.params.workspaceId,
        userId: request.auth.user.id,
      });
      return deleted ? response.status(204).end() : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:workspaceId/members', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    try {
      const members = await repository.listMembersForMember({
        workspaceId: request.params.workspaceId,
        userId: request.auth.user.id,
      });
      if (members.length === 0) {
        const workspace = await repository.getWorkspaceForMember({
          workspaceId: request.params.workspaceId,
          userId: request.auth.user.id,
        });
        if (!workspace) return notFound(response);
      }
      return response.status(200).json({ members });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:workspaceId/members', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    const { userId, role = 'member' } = request.body ?? {};
    if (!isUuid(userId) || !isAssignableRole(role)) {
      return response.status(400).json({ error: 'A valid user ID and assignable role are required.' });
    }
    try {
      const member = await repository.addMemberForManager({
        workspaceId: request.params.workspaceId,
        actorId: request.auth.user.id,
        userId,
        role,
      });
      return member ? response.status(201).json({ member }) : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:workspaceId/members/:userId', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId) || !isUuid(request.params.userId)) return notFound(response);
    const { role } = request.body ?? {};
    if (!isAssignableRole(role)) {
      return response.status(400).json({ error: 'Role must be admin or member.' });
    }
    try {
      const member = await repository.updateMemberRoleForOwner({
        workspaceId: request.params.workspaceId,
        actorId: request.auth.user.id,
        userId: request.params.userId,
        role,
      });
      return member ? response.status(200).json({ member }) : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:workspaceId/members/:userId', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId) || !isUuid(request.params.userId)) return notFound(response);
    try {
      const removed = await repository.removeMemberForManager({
        workspaceId: request.params.workspaceId,
        actorId: request.auth.user.id,
        userId: request.params.userId,
      });
      return removed ? response.status(204).end() : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function notFound(response) {
  return response.status(404).json({ error: 'Workspace or member not found.' });
}

module.exports = { createWorkspaceRouter };
