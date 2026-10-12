const { Kafka } = require('kafkajs');
const { readOutboxWorkerConfig } = require('../outbox/config');
const { getPool } = require('../db/pool');
const { createOutboxPublisherService } = require('../services/outbox-publisher');

async function runOutboxWorker({ producer, publisher, pollIntervalMs, shouldStop, writeLog = process.stderr.write.bind(process.stderr) }) {
  let connected = false;
  try {
    while (!shouldStop()) {
      try {
        if (!connected) {
          await producer.connect();
          connected = true;
        }
        const result = await publisher.publishReadyBatch();
        if (result.claimed === 0) await pause(pollIntervalMs);
      } catch (error) {
        const category = error?.code === 'SERVICE_UNAVAILABLE' || String(error?.code ?? '').startsWith('08')
          ? 'database_unavailable'
          : 'worker_or_broker_unavailable';
        writeLog(`Outbox worker encountered ${category}; it will retry.\n`);
        if (connected) {
          try { await producer.disconnect(); } catch { /* A later connect attempt will recover. */ }
          connected = false;
        }
        await pause(pollIntervalMs);
      }
    }
  } finally {
    if (connected) {
      try { await producer.disconnect(); } catch { /* Shutdown continues. */ }
    }
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const config = readOutboxWorkerConfig();
  const kafka = new Kafka({
    clientId: 'teamvault-outbox-relay',
    brokers: config.brokers,
    ssl: config.ssl,
    sasl: config.sasl,
  });
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  const publisher = createOutboxPublisherService({
    producer,
    topic: config.topic,
    options: config,
  });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runOutboxWorker({
      producer,
      publisher,
      pollIntervalMs: config.pollIntervalMs,
      shouldStop: () => stopping,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await getPool().end(); } catch { /* No database pool may have been opened. */ }
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Outbox worker could not start; check its configuration and service availability.\n');
    process.exitCode = 1;
  });
}

module.exports = { runOutboxWorker };
