function readOutboxWorkerConfig(env = process.env) {
  const brokers = (env.KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length === 0 || brokers.some((broker) => !isBrokerAddress(broker))) {
    throw new Error('KAFKA_BROKERS must contain comma-separated host:port values.');
  }

  const topic = env.KAFKA_TOPIC ?? 'teamvault.domain-events';
  if (!/^[A-Za-z0-9._-]{1,249}$/u.test(topic)) throw new Error('KAFKA_TOPIC is invalid.');

  const username = env.KAFKA_SASL_USERNAME;
  const password = env.KAFKA_SASL_PASSWORD;
  const mechanism = env.KAFKA_SASL_MECHANISM;
  const ssl = env.KAFKA_SSL === 'true';
  if (env.KAFKA_SSL !== undefined && !['true', 'false'].includes(env.KAFKA_SSL)) {
    throw new Error('KAFKA_SSL must be true or false.');
  }
  if ([username, password, mechanism].some(Boolean)) {
    if (!username || !password || !['plain', 'scram-sha-256', 'scram-sha-512'].includes(mechanism) || !ssl) {
      throw new Error('Kafka SASL requires a complete mechanism, username, password, and TLS.');
    }
  }

  return Object.freeze({
    brokers,
    topic,
    ssl,
    sasl: username ? { mechanism, username, password } : undefined,
    pollIntervalMs: integerSetting(env.OUTBOX_POLL_INTERVAL_MS, 1000, 50, 60_000, 'OUTBOX_POLL_INTERVAL_MS'),
    batchSize: integerSetting(env.OUTBOX_BATCH_SIZE, 50, 1, 500, 'OUTBOX_BATCH_SIZE'),
    leaseMs: integerSetting(env.OUTBOX_LEASE_MS, 30_000, 1000, 300_000, 'OUTBOX_LEASE_MS'),
    maxAttempts: integerSetting(env.OUTBOX_MAX_ATTEMPTS, 12, 1, 100, 'OUTBOX_MAX_ATTEMPTS'),
    baseDelayMs: integerSetting(env.OUTBOX_RETRY_BASE_MS, 1000, 10, 300_000, 'OUTBOX_RETRY_BASE_MS'),
    maxDelayMs: integerSetting(env.OUTBOX_RETRY_MAX_MS, 300_000, 10, 86_400_000, 'OUTBOX_RETRY_MAX_MS'),
  });
}

function isBrokerAddress(value) {
  const match = /^(?:\[([0-9A-Fa-f:]+)\]|([A-Za-z0-9.-]+)):(\d{1,5})$/u.exec(value);
  return Boolean(match && Number(match[3]) > 0 && Number(match[3]) <= 65535);
}

function integerSetting(value, fallback, min, max, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

module.exports = { isBrokerAddress, readOutboxWorkerConfig };
