const request = require('supertest');
const { createActivityService } = require('../src/services/activity');
const { createCommentService } = require('../src/services/comments');
const { createProjectService } = require('../src/services/projects');
const { createServices } = require('../src/services/create-services');
const { createWorkspaceService } = require('../src/services/workspaces');
const { createApp } = require('../src/app');

describe('service boundaries', () => {
  test('workspace service delegates only its supported API', async () => {
    const repository = { createWorkspaceForUser: jest.fn(async (value) => value) };
    const service = createWorkspaceService(repository);

    await expect(service.createWorkspaceForUser({ userId: 'user-1' })).resolves.toEqual({ userId: 'user-1' });
    expect(repository.createWorkspaceForUser).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(service)).toContain('addMemberForManager');
    expect(Object.keys(service)).not.toContain('withTransaction');
  });

  test('project, comment, and activity service methods delegate to their owning repositories', async () => {
    const projectRepository = { updateTaskForMember: jest.fn(async () => ({ kind: 'updated' })) };
    const commentRepository = { createComment: jest.fn(async () => ({ id: 'comment-1' })) };
    const activityRepository = {
      listActivityForMember: jest.fn(async () => ({ authorized: true, events: [] })),
      recordActivity: jest.fn(async () => undefined),
    };
    const projects = createProjectService(projectRepository);
    const comments = createCommentService(commentRepository);
    const activity = createActivityService(activityRepository);

    await expect(projects.updateTaskForMember({ taskId: 'task-1' })).resolves.toEqual({ kind: 'updated' });
    await expect(comments.createComment({ content: 'hello' })).resolves.toEqual({ id: 'comment-1' });
    await expect(activity.listActivityForMember({ workspaceId: 'workspace-1' }))
      .resolves.toEqual({ authorized: true, events: [] });
    const transactionClient = { query: jest.fn() };
    await activity.recordActivityInTransaction(transactionClient, { eventType: 'task_updated' });
    expect(projectRepository.updateTaskForMember).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(commentRepository.createComment).toHaveBeenCalledWith({ content: 'hello' });
    expect(activityRepository.listActivityForMember).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
    expect(activityRepository.recordActivity).toHaveBeenCalledWith(transactionClient, { eventType: 'task_updated' });

    const rejectedActivityRepository = {
      recordActivity: jest.fn(async () => { throw new Error('write rejected'); }),
    };
    const rejectingActivity = createActivityService(rejectedActivityRepository);
    await expect(rejectingActivity.recordActivityInTransaction(transactionClient, { eventType: 'task_updated' }))
      .rejects.toThrow('write rejected');
    expect(rejectedActivityRepository.recordActivity).toHaveBeenCalledWith(
      transactionClient, { eventType: 'task_updated' },
    );
  });

  test('composition creates a frozen service registry with injectable repository ownership', () => {
    const repositories = {
      workspaces: { getWorkspaceForMember: jest.fn() },
      projects: { getProjectForMember: jest.fn() },
      comments: { listCommentsForMember: jest.fn() },
      activity: { listActivityForMember: jest.fn() },
    };
    const services = createServices(repositories);

    expect(Object.isFrozen(services)).toBe(true);
    expect(Object.keys(services)).toEqual(['workspaces', 'projects', 'comments', 'activity']);
    expect(Object.isFrozen(services.projects)).toBe(true);
    expect(Object.keys(services.projects)).not.toContain('getPool');
  });

  test('app composition injects the activity service into its authenticated route', async () => {
    const activityRepository = {
      listActivityForMember: jest.fn(async () => ({ authorized: true, events: [{ id: '19' }] })),
    };
    const services = createServices({ activity: activityRepository });
    const authService = { authenticate: jest.fn(async () => ({ id: 'user-7' })) };
    const app = createApp({ authService, services });

    const response = await request(app)
      .get('/api/workspaces/11111111-1111-4111-8111-111111111111/activity')
      .set('Authorization', `Bearer ${'t'.repeat(43)}`);

    expect(response.status).toBe(200);
    expect(response.body.events).toEqual([{ id: '19' }]);
    expect(activityRepository.listActivityForMember).toHaveBeenCalledWith({
      workspaceId: '11111111-1111-4111-8111-111111111111', actorId: 'user-7', limit: 50, before: null,
    });
  });
});
