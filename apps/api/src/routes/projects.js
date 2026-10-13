const express = require('express');
const { createRequireAuth } = require('../middleware/require-auth');
const { createProjectService } = require('../services/projects');
const {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  hasOnlyKeys,
  isUuid,
  validateDescription,
  validateDueDate,
  validateRequiredText,
  validateTaskPriority,
  validateTaskStatus,
  validateVersion,
} = require('../projects/validation');

function createProjectsRouter(authService, projectService = createProjectService(), realtimeHub) {
  const router = express.Router();
  router.use(createRequireAuth(authService));

  router.post('/:workspaceId/projects', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    if (!hasOnlyKeys(request.body, ['name', 'description'])) return invalid(response);
    const name = validateRequiredText(request.body.name, PROJECT_NAME_MAX);
    const description = request.body.description === undefined
      ? { valid: true, value: null }
      : validateDescription(request.body.description, PROJECT_DESCRIPTION_MAX);
    if (!name.valid || !description.valid) return invalid(response);

    try {
      const project = await projectService.createProject({
        workspaceId: request.params.workspaceId,
        actorId: request.auth.user.id,
        name: name.value,
        description: description.value,
      });
      if (!project) return notFound(response);
      publish(realtimeHub, request.params.workspaceId, 'project', project.id, 'created');
      return response.status(201).json({ project });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:workspaceId/projects', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    try {
      const result = await projectService.listProjectsForMember({
        workspaceId: request.params.workspaceId,
        actorId: request.auth.user.id,
      });
      return result.authorized
        ? response.status(200).json({ projects: result.projects })
        : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:workspaceId/projects/:projectId', async (request, response, next) => {
    if (!validResourceIds(request)) return notFound(response);
    try {
      const project = await projectService.getProjectForMember({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        actorId: request.auth.user.id,
      });
      if (!project) return notFound(response);
      return response.status(200).json({ project });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:workspaceId/projects/:projectId', async (request, response, next) => {
    if (!validResourceIds(request)) return notFound(response);
    if (!hasOnlyKeys(request.body, ['name', 'description'])) return invalid(response);
    const name = request.body.name === undefined
      ? { valid: true, provided: false, value: null }
      : { ...validateRequiredText(request.body.name, PROJECT_NAME_MAX), provided: true };
    const description = request.body.description === undefined
      ? { valid: true, provided: false, value: null }
      : { ...validateDescription(request.body.description, PROJECT_DESCRIPTION_MAX), provided: true };
    if (
      Object.keys(request.body).length === 0
      || !name.valid
      || !description.valid
    ) return invalid(response);

    try {
      const project = await projectService.updateProjectForManager({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        actorId: request.auth.user.id,
        name,
        description,
      });
      if (!project) return notFound(response);
      publish(realtimeHub, request.params.workspaceId, 'project', project.id, 'updated');
      return response.status(200).json({ project });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:workspaceId/projects/:projectId', async (request, response, next) => {
    if (!validResourceIds(request)) return notFound(response);
    try {
      const deleted = await projectService.deleteProjectForManager({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        actorId: request.auth.user.id,
      });
      if (!deleted) return notFound(response);
      publish(realtimeHub, request.params.workspaceId, 'project', request.params.projectId, 'deleted');
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:workspaceId/projects/:projectId/tasks', async (request, response, next) => {
    if (!validResourceIds(request)) return notFound(response);
    const input = validateTaskCreate(request.body);
    if (!input.valid) return invalid(response);
    try {
      const result = await projectService.createTask({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        actorId: request.auth.user.id,
        task: input.task,
      });
      if (result.kind === 'not_found') return notFound(response);
      if (result.kind === 'invalid_assignee') {
        return response.status(400).json({ error: 'Assignee must be a member of this workspace.' });
      }
      publish(realtimeHub, request.params.workspaceId, 'task', result.task.id, 'created');
      return response.status(201).json({ task: result.task });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:workspaceId/projects/:projectId/tasks', async (request, response, next) => {
    if (!validResourceIds(request)) return notFound(response);
    try {
      const result = await projectService.listTasksForMember({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        actorId: request.auth.user.id,
      });
      return result.authorized
        ? response.status(200).json({ tasks: result.tasks })
        : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:workspaceId/projects/:projectId/tasks/:taskId', async (request, response, next) => {
    if (!validResourceIds(request, 'taskId')) return notFound(response);
    try {
      const task = await projectService.getTaskForMember({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        taskId: request.params.taskId,
        actorId: request.auth.user.id,
      });
      return task ? response.status(200).json({ task }) : notFound(response);
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:workspaceId/projects/:projectId/tasks/:taskId', async (request, response, next) => {
    if (!validResourceIds(request, 'taskId')) return notFound(response);
    const input = validateTaskPatch(request.body);
    if (!input.valid) return invalid(response);
    try {
      const result = await projectService.updateTaskForMember({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        taskId: request.params.taskId,
        actorId: request.auth.user.id,
        expectedVersion: input.version,
        changes: input.changes,
      });
      if (result.kind === 'not_found') return notFound(response);
      if (result.kind === 'conflict') return response.status(409).json({ error: 'Task was changed; reload it and retry.' });
      if (result.kind === 'invalid_assignee') {
        return response.status(400).json({ error: 'Assignee must be a member of this workspace.' });
      }
      publish(realtimeHub, request.params.workspaceId, 'task', result.task.id, 'updated');
      return response.status(200).json({ task: result.task });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:workspaceId/projects/:projectId/tasks/:taskId', async (request, response, next) => {
    if (!validResourceIds(request, 'taskId')) return notFound(response);
    try {
      const deleted = await projectService.deleteTaskForManager({
        workspaceId: request.params.workspaceId,
        projectId: request.params.projectId,
        taskId: request.params.taskId,
        actorId: request.auth.user.id,
      });
      if (!deleted) return notFound(response);
      publish(realtimeHub, request.params.workspaceId, 'task', request.params.taskId, 'deleted');
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function publish(realtimeHub, workspaceId, resourceType, resourceId, action) {
  if (realtimeHub) void realtimeHub.publishWorkspaceEvent({ workspaceId, resourceType, resourceId, action }).catch(() => {});
}

function validateTaskCreate(body) {
  if (!hasOnlyKeys(body, ['title', 'description', 'status', 'priority', 'assigneeId', 'dueDate'])) {
    return { valid: false };
  }
  const title = validateRequiredText(body.title, TASK_TITLE_MAX);
  const description = body.description === undefined
    ? { valid: true, value: null }
    : validateDescription(body.description, TASK_DESCRIPTION_MAX);
  const status = body.status === undefined ? 'todo' : body.status;
  const priority = body.priority === undefined ? 'medium' : body.priority;
  const assigneeId = body.assigneeId ?? null;
  const dueDate = body.dueDate ?? null;
  if (
    !title.valid
    || !description.valid
    || !validateTaskStatus(status)
    || !validateTaskPriority(priority)
    || (assigneeId !== null && !isUuid(assigneeId))
    || !validateDueDate(dueDate)
  ) return { valid: false };
  return {
    valid: true,
    task: { title: title.value, description: description.value, status, priority, assigneeId, dueDate },
  };
}

function validateTaskPatch(body) {
  const allowedKeys = ['version', 'title', 'description', 'status', 'priority', 'assigneeId', 'dueDate'];
  if (!hasOnlyKeys(body, allowedKeys) || !Object.hasOwn(body, 'version') || !validateVersion(body.version)) {
    return { valid: false };
  }
  const fields = allowedKeys.filter((key) => key !== 'version');
  if (!fields.some((field) => Object.hasOwn(body, field))) return { valid: false };

  const title = Object.hasOwn(body, 'title')
    ? validateRequiredText(body.title, TASK_TITLE_MAX)
    : { valid: true, value: null };
  const description = Object.hasOwn(body, 'description')
    ? validateDescription(body.description, TASK_DESCRIPTION_MAX)
    : { valid: true, value: null };
  const status = body.status;
  const priority = body.priority;
  const assigneeId = body.assigneeId;
  const dueDate = body.dueDate;
  if (
    !title.valid
    || !description.valid
    || (Object.hasOwn(body, 'status') && !validateTaskStatus(status))
    || (Object.hasOwn(body, 'priority') && !validateTaskPriority(priority))
    || (Object.hasOwn(body, 'assigneeId') && assigneeId !== null && !isUuid(assigneeId))
    || (Object.hasOwn(body, 'dueDate') && !validateDueDate(dueDate))
  ) return { valid: false };

  return {
    valid: true,
    version: body.version,
    changes: {
      title: { provided: Object.hasOwn(body, 'title'), value: title.value },
      description: { provided: Object.hasOwn(body, 'description'), value: description.value },
      status: { provided: Object.hasOwn(body, 'status'), value: status ?? null },
      priority: { provided: Object.hasOwn(body, 'priority'), value: priority ?? null },
      assigneeId: { provided: Object.hasOwn(body, 'assigneeId'), value: assigneeId ?? null },
      dueDate: { provided: Object.hasOwn(body, 'dueDate'), value: dueDate ?? null },
    },
  };
}

function validResourceIds(request, finalIdName = 'projectId') {
  return isUuid(request.params.workspaceId)
    && isUuid(request.params.projectId)
    && (finalIdName === 'projectId' || isUuid(request.params[finalIdName]));
}

function invalid(response) {
  return response.status(400).json({ error: 'Invalid request.' });
}

function notFound(response) {
  return response.status(404).json({ error: 'Project, task, or workspace not found.' });
}

module.exports = { createProjectsRouter };
