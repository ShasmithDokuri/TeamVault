const outboxRepository = require('../outbox/repository');

const DEFAULTS = Object.freeze({
  batchSize: 50,
  leaseMs: 30_000,
  maxAttempts: 12,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
});

function createOutboxPublisherService({ repository = outboxRepository, producer, topic, options = {} }) {
  if (!producer || typeof producer.send !== 'function') throw new TypeError('A Kafka producer is required.');
  if (typeof topic !== 'string' || !/^[A-Za-z0-9._-]{1,249}$/u.test(topic)) {
    throw new TypeError('A valid Kafka topic is required.');
  }
  const settings = { ...DEFAULTS, ...options };

  return Object.freeze({
    async publishReadyBatch() {
      const events = await repository.claimReadyEvents({
        batchSize: settings.batchSize,
        leaseMs: settings.leaseMs,
        maxAttempts: settings.maxAttempts,
      });
      const summary = { claimed: events.length, published: 0, retried: 0, deadLettered: 0 };
      const leases = await Promise.all(events.map((event) => startLeaseRenewal(repository, event, settings.leaseMs)));

      try {
        for (const [index, event] of events.entries()) {
          const lease = leases[index];
          if (!lease) continue;

          let sendError;
          try {
            await producer.send({
              topic,
              acks: -1,
              messages: [{
                key: event.workspaceId,
                value: JSON.stringify(event.payload),
                headers: { 'event-id': event.id, 'event-type': event.eventType },
              }],
            });
          } catch (error) {
            sendError = error;
          }

          const stillOwned = await lease.stop();
          leases[index] = null;
          if (!stillOwned) continue;

          if (sendError) {
            const deadLettered = await repository.rescheduleEvent({
              id: event.id,
              leaseToken: event.leaseToken,
              delayMs: retryDelayMs(event.attempts, settings),
              errorCode: classifyPublishError(sendError),
              maxAttempts: settings.maxAttempts,
            });
            if (deadLettered) summary.deadLettered += 1;
            else summary.retried += 1;
            continue;
          }

          if (await repository.markEventPublished({ id: event.id, leaseToken: event.leaseToken })) {
            summary.published += 1;
          }
        }
      } finally {
        await Promise.all(leases.filter(Boolean).map((lease) => lease.stop()));
      }

      return summary;
    },
  });
}

async function startLeaseRenewal(repository, event, leaseMs) {
  const leaseInput = { id: event.id, leaseToken: event.leaseToken, leaseMs };
  if (!await repository.renewEventLease(leaseInput)) return null;

  let active = true;
  let lost = false;
  let renewalInFlight = null;
  const interval = setInterval(() => {
    if (!active || renewalInFlight) return;
    renewalInFlight = repository.renewEventLease(leaseInput)
      .then((renewed) => { if (!renewed) lost = true; })
      .catch(() => { lost = true; })
      .finally(() => { renewalInFlight = null; });
  }, Math.max(100, Math.floor(leaseMs / 3)));

  return {
    async stop() {
      active = false;
      clearInterval(interval);
      if (renewalInFlight) await renewalInFlight;
      return !lost;
    },
  };
}

function retryDelayMs(attempt, { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs } = {}) {
  const safeAttempt = Math.max(1, Math.min(Number.isInteger(attempt) ? attempt : 1, 30));
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (safeAttempt - 1)));
  return Math.min(maxDelayMs, Math.round(exponentialDelay * (0.75 + Math.random() * 0.5)));
}

function classifyPublishError(error) {
  if (error?.retriable === false) return 'publish_rejected';
  return 'broker_unavailable';
}

module.exports = { classifyPublishError, createOutboxPublisherService, retryDelayMs };
