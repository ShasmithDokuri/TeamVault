const { createOutboxPublisherService, retryDelayMs } = require('../src/services/outbox-publisher');
const { readOutboxWorkerConfig } = require('../src/outbox/config');
const { runOutboxWorker } = require('../src/workers/outbox-publisher');

const readyEvent = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  eventType: 'project_created',
  payload: { id: '22222222-2222-4222-8222-222222222222', type: 'project_created', schemaVersion: 1 },
  attempts: 1,
  leaseToken: '33333333-3333-4333-8333-333333333333',
};

describe('outbox publisher', () => {
  test('publishes a stable event ID keyed by workspace and acknowledges the current lease', async () => {
    const producer = { send: jest.fn().mockResolvedValue(undefined) };
    const repository = {
      claimReadyEvents: jest.fn().mockResolvedValue([readyEvent]),
      renewEventLease: jest.fn().mockResolvedValue(true),
      markEventPublished: jest.fn().mockResolvedValue(true),
      rescheduleEvent: jest.fn(),
    };
    const publisher = createOutboxPublisherService({ producer, repository, topic: 'teamvault.domain-events' });

    await expect(publisher.publishReadyBatch()).resolves.toEqual({ claimed: 1, published: 1, retried: 0, deadLettered: 0 });
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'teamvault.domain-events',
      acks: -1,
      messages: [{
        key: readyEvent.workspaceId,
        value: JSON.stringify(readyEvent.payload),
        headers: { 'event-id': readyEvent.id, 'event-type': readyEvent.eventType },
      }],
    });
    expect(repository.markEventPublished).toHaveBeenCalledWith({ id: readyEvent.id, leaseToken: readyEvent.leaseToken });
    expect(repository.renewEventLease).toHaveBeenCalledWith({
      id: readyEvent.id, leaseToken: readyEvent.leaseToken, leaseMs: 30_000,
    });
  });

  test('does not publish or acknowledge an event when its lease has already been lost', async () => {
    const producer = { send: jest.fn() };
    const repository = {
      claimReadyEvents: jest.fn().mockResolvedValue([readyEvent]),
      renewEventLease: jest.fn().mockResolvedValue(false),
      markEventPublished: jest.fn(),
      rescheduleEvent: jest.fn(),
    };
    const publisher = createOutboxPublisherService({ producer, repository, topic: 'teamvault.domain-events' });

    await expect(publisher.publishReadyBatch()).resolves.toMatchObject({ claimed: 1, published: 0 });
    expect(producer.send).not.toHaveBeenCalled();
    expect(repository.markEventPublished).not.toHaveBeenCalled();
    expect(repository.rescheduleEvent).not.toHaveBeenCalled();
  });

  test('schedules failed sends with bounded backoff and stores only a safe error category', async () => {
    const producer = { send: jest.fn().mockRejectedValue(new Error('sasl_password=do-not-store')) };
    const repository = {
      claimReadyEvents: jest.fn().mockResolvedValue([readyEvent]),
      renewEventLease: jest.fn().mockResolvedValue(true),
      markEventPublished: jest.fn(),
      rescheduleEvent: jest.fn().mockResolvedValue(false),
    };
    const publisher = createOutboxPublisherService({ producer, repository, topic: 'teamvault.domain-events' });

    await expect(publisher.publishReadyBatch()).resolves.toMatchObject({ retried: 1, deadLettered: 0 });
    expect(repository.rescheduleEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: readyEvent.id,
      leaseToken: readyEvent.leaseToken,
      errorCode: 'broker_unavailable',
      maxAttempts: 12,
    }));
    expect(JSON.stringify(repository.rescheduleEvent.mock.calls)).not.toContain('do-not-store');
    expect(retryDelayMs(99, { baseDelayMs: 1000, maxDelayMs: 5000 })).toBeLessThanOrEqual(5000);
  });

  test('reuses the stable event ID when Kafka accepted a send but database acknowledgment failed', async () => {
    const producer = { send: jest.fn().mockResolvedValue(undefined) };
    const repository = {
      claimReadyEvents: jest.fn()
        .mockResolvedValueOnce([readyEvent])
        .mockResolvedValueOnce([{ ...readyEvent, leaseToken: '55555555-5555-4555-8555-555555555555' }]),
      renewEventLease: jest.fn().mockResolvedValue(true),
      markEventPublished: jest.fn()
        .mockRejectedValueOnce(new Error('database acknowledgment unavailable'))
        .mockResolvedValueOnce(true),
      rescheduleEvent: jest.fn(),
    };
    const publisher = createOutboxPublisherService({ producer, repository, topic: 'teamvault.domain-events' });

    await expect(publisher.publishReadyBatch()).rejects.toThrow('database acknowledgment unavailable');
    await expect(publisher.publishReadyBatch()).resolves.toMatchObject({ published: 1 });
    expect(producer.send).toHaveBeenCalledTimes(2);
    expect(producer.send.mock.calls[0][0].messages[0].headers['event-id'])
      .toBe(producer.send.mock.calls[1][0].messages[0].headers['event-id']);
  });

  test('retries broker connection failures without logging raw error details', async () => {
    let stopping = false;
    const producer = {
      connect: jest.fn().mockRejectedValueOnce(new Error('secret=hidden')).mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const publisher = { publishReadyBatch: jest.fn(async () => {
      stopping = true;
      return { claimed: 0 };
    }) };
    const logs = [];
    await runOutboxWorker({
      producer, publisher, pollIntervalMs: 1,
      shouldStop: () => stopping,
      writeLog: (line) => logs.push(line),
    });
    stopping = true;

    expect(producer.connect).toHaveBeenCalledTimes(2);
    expect(producer.disconnect).toHaveBeenCalledTimes(1);
    expect(publisher.publishReadyBatch).toHaveBeenCalled();
    expect(logs.join('')).toContain('worker_or_broker_unavailable');
    expect(logs.join('')).not.toContain('secret=hidden');
  });
});

describe('outbox worker configuration', () => {
  test('parses local brokers and bounded retry settings', () => {
    expect(readOutboxWorkerConfig({
      KAFKA_BROKERS: 'localhost:9092, kafka.local:9093',
      KAFKA_TOPIC: 'teamvault.domain-events',
      OUTBOX_BATCH_SIZE: '25',
    })).toMatchObject({
      brokers: ['localhost:9092', 'kafka.local:9093'],
      topic: 'teamvault.domain-events',
      batchSize: 25,
      maxAttempts: 12,
    });
  });

  test('rejects missing brokers and credential transmission without TLS', () => {
    expect(() => readOutboxWorkerConfig({})).toThrow('KAFKA_BROKERS');
    expect(() => readOutboxWorkerConfig({
      KAFKA_BROKERS: 'localhost:9092',
      KAFKA_SASL_USERNAME: 'worker',
      KAFKA_SASL_PASSWORD: 'secret',
      KAFKA_SASL_MECHANISM: 'plain',
    })).toThrow('TLS');
    expect(() => readOutboxWorkerConfig({ KAFKA_BROKERS: 'localhost:99999' })).toThrow('KAFKA_BROKERS');
    expect(() => readOutboxWorkerConfig({ KAFKA_BROKERS: 'localhost:9092', KAFKA_SSL: 'yes' })).toThrow('KAFKA_SSL');
  });
});
