const express = require('express');
const request = require('supertest');
jest.mock('../src/db/pool', () => ({ getPool: jest.fn() }));
const { getPool } = require('../src/db/pool');
const app = require('../src/app');
const errorHandler = require('../src/middleware/error-handler');

describe('GET /api/health', () => {
  test('returns an OK status for the local development health check', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  test('allows the configured browser origin through CORS', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  test('does not grant CORS access to other browser origins', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://untrusted.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('returns a safe client error for malformed JSON', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid request' });
  });
});

describe('GET /api/ready', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns ready only when PostgreSQL accepts a query', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });

    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
    expect(getPool().query).toHaveBeenCalledWith({ text: 'SELECT 1', query_timeout: 2000 });
  });

  test('returns a safe unavailable response when PostgreSQL is not ready', async () => {
    getPool.mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('private database detail')) });

    const response = await request(app).get('/api/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
    expect(JSON.stringify(response.body)).not.toContain('private database detail');
  });
});

describe('API error handling', () => {
  test('returns a generic server error without exposing internal details', async () => {
    const failingApp = express();
    failingApp.get('/failure', () => {
      throw new Error('sensitive internal detail');
    });
    failingApp.use(errorHandler);

    const response = await request(failingApp).get('/failure');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});
