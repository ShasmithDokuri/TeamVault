const express = require('express');
const { createRequireAuth } = require('../middleware/require-auth');
const { createActivityService } = require('../services/activity');
const { isUuid } = require('../projects/validation');

function createActivityRouter(authService, activityService = createActivityService()) {
  const router = express.Router();
  router.use(createRequireAuth(authService));
  router.get('/:workspaceId/activity', async (request, response, next) => {
    if (!isUuid(request.params.workspaceId)) return notFound(response);
    if (Object.keys(request.query).some((key) => !['limit', 'before'].includes(key))) {
      return response.status(400).json({ error: 'Invalid activity cursor or limit.' });
    }
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    const before = request.query.before === undefined ? null : request.query.before;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100
      || (before !== null && (!/^[1-9]\d{0,18}$/u.test(before) || BigInt(before) > 9223372036854775807n))) {
      return response.status(400).json({ error: 'Invalid activity cursor or limit.' });
    }
    try {
      const result = await activityService.listActivityForMember({
        workspaceId: request.params.workspaceId, actorId: request.auth.user.id,
        limit, before,
      });
      return result.authorized ? response.status(200).json({ events: result.events }) : notFound(response);
    } catch (error) { return next(error); }
  });
  return router;
}

function notFound(response) { return response.status(404).json({ error: 'Workspace not found.' }); }

module.exports = { createActivityRouter };
