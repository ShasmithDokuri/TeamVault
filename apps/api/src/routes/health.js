const express = require('express');
const { getPool } = require('../db/pool');

const router = express.Router();
const readinessRouter = express.Router();

router.get('/', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

readinessRouter.get('/', async (_request, response) => {
  try {
    await getPool().query({ text: 'SELECT 1', query_timeout: 2000 });
    response.status(200).json({ status: 'ready' });
  } catch {
    response.status(503).json({ status: 'not_ready' });
  }
});

module.exports = { healthRouter: router, readinessRouter };
