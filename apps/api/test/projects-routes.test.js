const express = require('express');
const request = require('supertest');
const { createProjectsRouter } = require('../src/routes/projects');

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';

describe('project routes', () => {
  function createUpdateApp({ user = { id: 'user-1' }, updateResult, updateError } = {}) {
    const authService = { authenticate: jest.fn().mockResolvedValue(user) };
    const projectService = {
      updateProjectForManager: jest.fn(async () => {
        if (updateError) throw updateError;
        return updateResult;
      }),
    };
    const realtimeHub = { publishWorkspaceEvent: jest.fn().mockResolvedValue(true) };
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces', createProjectsRouter(authService, projectService, realtimeHub));
    app.use((error, _request, response, _next) => response.status(500).json({ error: 'Internal server error.' }));
    return { app, authService, projectService, realtimeHub };
  }

  test('reading a project does not publish a change event', async () => {
    const authService = { authenticate: jest.fn().mockResolvedValue({ id: 'user-1' }) };
    const projectService = {
      getProjectForMember: jest.fn().mockResolvedValue({ id: projectId, workspaceId, name: 'Project' }),
    };
    const realtimeHub = { publishWorkspaceEvent: jest.fn().mockResolvedValue(true) };
    const app = express();
    app.use('/api/workspaces', createProjectsRouter(authService, projectService, realtimeHub));

    const response = await request(app)
      .get(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${'a'.repeat(43)}`);

    expect(response.status).toBe(200);
    expect(response.body.project.id).toBe(projectId);
    expect(realtimeHub.publishWorkspaceEvent).not.toHaveBeenCalled();
  });

  test('successful project update publishes a project/updated event', async () => {
    const project = { id: projectId, workspaceId, name: 'Updated project' };
    const { app, realtimeHub } = createUpdateApp({ updateResult: project });

    const response = await request(app)
      .patch(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .send({ name: 'Updated project' });

    expect(response.status).toBe(200);
    expect(response.body.project).toEqual(project);
    expect(realtimeHub.publishWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(realtimeHub.publishWorkspaceEvent).toHaveBeenCalledWith({
      workspaceId, resourceType: 'project', resourceId: projectId, action: 'updated',
    });
  });

  test('failed project update does not publish a change event', async () => {
    const { app, realtimeHub } = createUpdateApp({ updateError: new Error('database failure') });

    const response = await request(app)
      .patch(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .send({ name: 'Updated project' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error.' });
    expect(realtimeHub.publishWorkspaceEvent).not.toHaveBeenCalled();
  });

  test('unauthorized project update does not publish a change event', async () => {
    const { app, projectService, realtimeHub } = createUpdateApp({ user: null });

    const response = await request(app)
      .patch(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .send({ name: 'Updated project' });

    expect(response.status).toBe(401);
    expect(projectService.updateProjectForManager).not.toHaveBeenCalled();
    expect(realtimeHub.publishWorkspaceEvent).not.toHaveBeenCalled();
  });

  test('cross-workspace project update does not publish a change event', async () => {
    const otherWorkspaceId = '33333333-3333-4333-8333-333333333333';
    const { app, projectService, realtimeHub } = createUpdateApp({ updateResult: null });

    const response = await request(app)
      .patch(`/api/workspaces/${otherWorkspaceId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${'a'.repeat(43)}`)
      .send({ name: 'Updated project' });

    expect(response.status).toBe(404);
    expect(projectService.updateProjectForManager).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: otherWorkspaceId,
      projectId,
      actorId: 'user-1',
    }));
    expect(realtimeHub.publishWorkspaceEvent).not.toHaveBeenCalled();
  });
});
