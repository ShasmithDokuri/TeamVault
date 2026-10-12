const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');

async function enqueueEvent(client, { id, workspaceId, eventType, payload }) {
  await client.query(
    `INSERT INTO outbox_events (id, workspace_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [id, workspaceId, eventType, JSON.stringify(payload)],
  );
}

async function claimReadyEvents({ batchSize, leaseMs, workspaceId = null, maxAttempts = 12 }) {
  const client = await getPool().connect();
  const leaseToken = randomUUID();
  const workspaceClause = workspaceId ? 'AND workspace_id = $4' : '';
  const parameters = workspaceId ? [batchSize, leaseToken, leaseMs, workspaceId] : [batchSize, leaseToken, leaseMs];
  try {
    await client.query('BEGIN');
    const deadLetterWorkspaceClause = workspaceId ? 'AND workspace_id = $2' : '';
    const deadLetterParameters = workspaceId ? [maxAttempts, workspaceId] : [maxAttempts];
    await client.query(
      `UPDATE outbox_events
       SET dead_lettered_at = NOW(), lease_token = NULL, lease_expires_at = NULL,
           last_error_code = 'unknown'
       WHERE published_at IS NULL AND dead_lettered_at IS NULL
         AND attempts >= $1 AND lease_expires_at <= NOW()
         ${deadLetterWorkspaceClause}`,
      deadLetterParameters,
    );
    const { rows } = await client.query(
      `WITH ready AS (
         SELECT id
         FROM outbox_events
         WHERE published_at IS NULL AND dead_lettered_at IS NULL
           AND available_at <= NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
           ${workspaceClause}
         ORDER BY available_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE outbox_events AS event
       SET lease_token = $2,
           lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           attempts = event.attempts + 1
       FROM ready
       WHERE event.id = ready.id
       RETURNING event.id, event.workspace_id AS "workspaceId", event.event_type AS "eventType",
                 event.payload, event.attempts, event.lease_token AS "leaseToken"`,
      parameters,
    );
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    client.release();
  }
}

async function markEventPublished({ id, leaseToken }) {
  const { rowCount } = await getPool().query(
    `UPDATE outbox_events
     SET published_at = NOW(), lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
     WHERE id = $1 AND lease_token = $2 AND lease_expires_at > NOW()
       AND published_at IS NULL AND dead_lettered_at IS NULL`,
    [id, leaseToken],
  );
  return rowCount === 1;
}

async function renewEventLease({ id, leaseToken, leaseMs }) {
  const { rowCount } = await getPool().query(
    `UPDATE outbox_events
     SET lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
     WHERE id = $1 AND lease_token = $2 AND lease_expires_at > NOW()
       AND published_at IS NULL AND dead_lettered_at IS NULL
       AND lease_expires_at > NOW()`,
    [id, leaseToken, leaseMs],
  );
  return rowCount === 1;
}

async function rescheduleEvent({ id, leaseToken, delayMs, errorCode, maxAttempts }) {
  const { rows } = await getPool().query(
    `UPDATE outbox_events
     SET available_at = CASE WHEN attempts >= $5 THEN available_at
                             ELSE NOW() + ($3::bigint * INTERVAL '1 millisecond') END,
         dead_lettered_at = CASE WHEN attempts >= $5 THEN NOW() ELSE NULL END,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error_code = $4
     WHERE id = $1 AND lease_token = $2 AND published_at IS NULL AND dead_lettered_at IS NULL
     RETURNING dead_lettered_at IS NOT NULL AS "deadLettered"`,
    [id, leaseToken, delayMs, errorCode, maxAttempts],
  );
  return rows[0]?.deadLettered ?? false;
}

module.exports = { claimReadyEvents, enqueueEvent, markEventPublished, renewEventLease, rescheduleEvent };
