const express = require('express');
const request = require('supertest');
const { createRequestLogger } = require('../src/middleware/request-logger');

describe('request logger', () => {
  test('writes bounded route metadata without request details or secrets', async () => {
    const entries = [];
    const app = express();
    app.use(createRequestLogger({ writeLog: (line) => entries.push(line), enabled: true }));
    app.post('/api/workspaces/:workspaceId/projects/:projectId', (_req, res) => res.status(201).json({ ok: true }));

    const response = await request(app)
      .post('/api/workspaces/workspace-secret-id/projects/project-secret-id?token=query-secret')
      .set('Cookie', 'session=cookie-secret')
      .send({ password: 'body-secret' });

    expect(response.status).toBe(201);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(entries[0]);
    expect(entry).toMatchObject({
      event: 'http_request',
      requestId: response.headers['x-request-id'],
      method: 'POST',
      route: '/api/workspaces/:workspaceId/projects/:projectId',
      status: 201,
    });
    expect(entry.durationMs).toEqual(expect.any(Number));
    expect(entries[0]).not.toMatch(/workspace-secret-id|project-secret-id|query-secret|cookie-secret|body-secret|password|token/iu);
  });

  test('does not write logs in the test runtime by default', async () => {
    const entries = [];
    const app = express();
    app.use(createRequestLogger({ writeLog: (line) => entries.push(line) }));
    app.get('/health', (_req, res) => res.sendStatus(200));

    await request(app).get('/health');
    expect(entries).toEqual([]);
  });
});
