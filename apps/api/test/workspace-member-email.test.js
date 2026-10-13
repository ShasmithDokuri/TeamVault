const request = require('supertest');
const { createApp } = require('../src/app');

describe('workspace member email flow', () => {
  test('normalizes a registered member email and keeps manager role checks in the service', async () => {
    const workspaceService = {
      addMemberForManager: jest.fn().mockResolvedValue({ user_id: 'target-1', email: 'teammate@example.com', role: 'member' }),
    };
    const app = createApp({
      authService: { authenticate: jest.fn().mockResolvedValue({ id: 'owner-1' }) },
      services: { workspaces: workspaceService },
    });

    const response = await request(app).post('/api/workspaces/11111111-1111-4111-8111-111111111111/members')
      .set('Authorization', `Bearer ${'x'.repeat(43)}`)
      .send({ email: ' Teammate@Example.com ', role: 'member' });

    expect(response.status).toBe(201);
    expect(workspaceService.addMemberForManager).toHaveBeenCalledWith({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      actorId: 'owner-1', userId: null, email: 'teammate@example.com', role: 'member',
    });
  });

  test('rejects invalid email and unauthorized role values before service invocation', async () => {
    const workspaceService = { addMemberForManager: jest.fn() };
    const app = createApp({
      authService: { authenticate: jest.fn().mockResolvedValue({ id: 'admin-1' }) },
      services: { workspaces: workspaceService },
    });
    const invalidEmail = await request(app).post('/api/workspaces/11111111-1111-4111-8111-111111111111/members')
      .set('Authorization', `Bearer ${'y'.repeat(43)}`).send({ email: 'invalid', role: 'member' });
    const invalidRole = await request(app).post('/api/workspaces/11111111-1111-4111-8111-111111111111/members')
      .set('Authorization', `Bearer ${'y'.repeat(43)}`).send({ email: 'teammate@example.com', role: 'owner' });

    expect(invalidEmail.status).toBe(400);
    expect(invalidRole.status).toBe(400);
    expect(workspaceService.addMemberForManager).not.toHaveBeenCalled();
  });
});
