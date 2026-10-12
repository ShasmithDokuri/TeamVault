const { randomUUID } = require('node:crypto');
const activityRepository = require('../activity/repository');
const outboxRepository = require('../outbox/repository');
const SAFE_CHANGED_FIELDS = new Set(['name', 'description', 'title', 'status', 'priority', 'assigneeId', 'dueDate']);

function createActivityService(repository = activityRepository, outbox = outboxRepository) {
  return Object.freeze({
    listActivityForMember: (input) => repository.listActivityForMember(input),
    async recordActivityInTransaction(client, input) {
      const activityEvent = await repository.recordActivity(client, input);
      const eventId = randomUUID();
      const payload = {
        id: eventId,
        type: input.eventType,
        schemaVersion: 1,
        occurredAt: activityEvent.createdAt.toISOString(),
        activityEventId: activityEvent.id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        entity: {
          type: input.entityType,
          id: input.entityId,
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          commentId: input.commentId ?? null,
        },
        metadata: safeMetadata(input.metadata),
      };
      await outbox.enqueueEvent(client, {
        id: eventId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        payload,
      });
      return { activityEventId: activityEvent.id, eventId };
    },
  });
}

function safeMetadata(metadata) {
  if (!metadata || !Array.isArray(metadata.changedFields)) return {};
  const changedFields = metadata.changedFields.filter((field) => SAFE_CHANGED_FIELDS.has(field));
  return changedFields.length ? { changedFields } : {};
}

module.exports = { createActivityService };
