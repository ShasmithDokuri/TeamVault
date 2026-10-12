const enabled = Boolean(process.env.TEAMVAULT_TEST_DATABASE_URL);
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase('PostgreSQL outbox integration', () => {
  let pool;
  let repository;
  const eventIds = [];

  beforeAll(async () => {
    const testUrl = process.env.TEAMVAULT_TEST_DATABASE_URL;
    const parsedUrl = new URL(testUrl);
    if (parsedUrl.pathname !== '/teamvault_m3_review'
      || !['', 'localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
      throw new Error('Integration tests require the local isolated teamvault_m3_review database.');
    }
    process.env.DATABASE_URL = testUrl;
    const fs = require('node:fs/promises');
    const path = require('node:path');
    pool = require('../src/db/pool').getPool();
    const migrationsPath = path.join(__dirname, '../migrations');
    const migrations = (await fs.readdir(migrationsPath))
      .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    for (const migration of migrations) {
      await pool.query(await fs.readFile(path.join(migrationsPath, migration), 'utf8'));
    }
    repository = require('../src/outbox/repository');
  });

  afterAll(async () => {
    if (!pool) return;
    if (eventIds.length) await pool.query('DELETE FROM outbox_events WHERE id = ANY($1::uuid[])', [eventIds]);
    await pool.end();
  });

  test('claims events once across concurrent workers, retries with a new lease, and fences stale acknowledgments', async () => {
    const id = require('node:crypto').randomUUID();
    const workspaceId = require('node:crypto').randomUUID();
    eventIds.push(id);
    await pool.query(
      `INSERT INTO outbox_events (id, workspace_id, event_type, payload)
       VALUES ($1, $2, 'project_created', $3::jsonb)`,
      [id, workspaceId, JSON.stringify({ id, type: 'project_created' })],
    );

    const claims = await Promise.all([
      repository.claimReadyEvents({ batchSize: 1, leaseMs: 10_000, workspaceId }),
      repository.claimReadyEvents({ batchSize: 1, leaseMs: 10_000, workspaceId }),
    ]);
    const claimed = claims.flat();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(id);
    expect(claimed[0].attempts).toBe(1);
    expect(await repository.markEventPublished({ id, leaseToken: '44444444-4444-4444-8444-444444444444' }))
      .toBe(false);
    expect(await repository.renewEventLease({
      id, leaseToken: claimed[0].leaseToken, leaseMs: 10_000,
    })).toBe(true);
    expect(await repository.renewEventLease({
      id, leaseToken: '44444444-4444-4444-8444-444444444444', leaseMs: 10_000,
    })).toBe(false);

    await pool.query(
      'UPDATE outbox_events SET lease_expires_at = NOW() - INTERVAL \'1 second\' WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId],
    );
    expect(await repository.markEventPublished({ id, leaseToken: claimed[0].leaseToken })).toBe(false);
    expect(await repository.rescheduleEvent({
      id, leaseToken: claimed[0].leaseToken, delayMs: 0,
      errorCode: 'broker_unavailable', maxAttempts: 3,
    })).toBe(false);
    const retried = await repository.claimReadyEvents({ batchSize: 1, leaseMs: 10_000, workspaceId });
    expect(retried).toHaveLength(1);
    expect(retried[0].attempts).toBe(2);
    expect(retried[0].leaseToken).not.toBe(claimed[0].leaseToken);
    expect(await repository.markEventPublished({ id, leaseToken: retried[0].leaseToken })).toBe(true);
    expect(await repository.claimReadyEvents({ batchSize: 1, leaseMs: 10_000, workspaceId })).toHaveLength(0);

    const terminalId = require('node:crypto').randomUUID();
    const terminalWorkspaceId = require('node:crypto').randomUUID();
    eventIds.push(terminalId);
    await pool.query(
      `INSERT INTO outbox_events (id, workspace_id, event_type, payload)
       VALUES ($1, $2, 'task_updated', $3::jsonb)`,
      [terminalId, terminalWorkspaceId, JSON.stringify({ id: terminalId, type: 'task_updated' })],
    );
    const finalAttempt = await repository.claimReadyEvents({
      batchSize: 1, leaseMs: 10_000, workspaceId: terminalWorkspaceId,
    });
    expect(finalAttempt).toHaveLength(1);
    expect(await repository.rescheduleEvent({
      id: terminalId, leaseToken: finalAttempt[0].leaseToken, delayMs: 0,
      errorCode: 'publish_rejected', maxAttempts: 1,
    })).toBe(true);
    expect(await repository.claimReadyEvents({
      batchSize: 1, leaseMs: 10_000, workspaceId: terminalWorkspaceId,
    })).toHaveLength(0);
    const deadLetter = await pool.query(
      'SELECT dead_lettered_at, last_error_code, payload FROM outbox_events WHERE id = $1',
      [terminalId],
    );
    expect(deadLetter.rows[0]).toMatchObject({ last_error_code: 'publish_rejected', payload: { id: terminalId } });
    expect(deadLetter.rows[0].dead_lettered_at).not.toBeNull();

    const crashedId = require('node:crypto').randomUUID();
    const crashedWorkspaceId = require('node:crypto').randomUUID();
    eventIds.push(crashedId);
    await pool.query(
      `INSERT INTO outbox_events (id, workspace_id, event_type, payload)
       VALUES ($1, $2, 'comment_created', $3::jsonb)`,
      [crashedId, crashedWorkspaceId, JSON.stringify({ id: crashedId, type: 'comment_created' })],
    );
    const abandoned = await repository.claimReadyEvents({
      batchSize: 1, leaseMs: 10_000, maxAttempts: 1, workspaceId: crashedWorkspaceId,
    });
    expect(abandoned).toHaveLength(1);
    await pool.query(
      'UPDATE outbox_events SET lease_expires_at = NOW() - INTERVAL \'1 second\' WHERE id = $1 AND workspace_id = $2',
      [crashedId, crashedWorkspaceId],
    );
    expect(await repository.claimReadyEvents({
      batchSize: 1, leaseMs: 10_000, maxAttempts: 1, workspaceId: crashedWorkspaceId,
    })).toHaveLength(0);
    const crashedDeadLetter = await pool.query(
      'SELECT dead_lettered_at, last_error_code FROM outbox_events WHERE id = $1 AND workspace_id = $2',
      [crashedId, crashedWorkspaceId],
    );
    expect(crashedDeadLetter.rows[0]).toMatchObject({ last_error_code: 'unknown' });
    expect(crashedDeadLetter.rows[0].dead_lettered_at).not.toBeNull();
  });
});
