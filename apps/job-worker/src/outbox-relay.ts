import { Pool, type QueryResultRow } from 'pg';
import { BullMqJobClient } from '@rhea/queue-adapter';
import type { JobClient } from '@rhea/job-runtime';

export interface OutboxEvent extends QueryResultRow {
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  family_space_id: string;
  id: string;
  learning_profile_id: string;
  occurred_at: Date;
  payload: unknown;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function dispatchOutboxJob(
  event: OutboxEvent,
  clients: { aiJobs: Pick<JobClient, 'submit'>; safetyJobs: Pick<JobClient, 'submit'> },
): Promise<boolean> {
  const payload = object(event.payload);
  if (event.event_type === 'privacy.task.requested') {
    await clients.safetyJobs.submit({
      deduplicationKey: event.aggregate_id,
      kind: 'privacy.process',
      payload: { taskId: event.aggregate_id },
    });
    return true;
  }
  if (payload.status !== 'queued') return false;
  if (event.event_type === 'submission.recognition_requested') {
    await clients.aiJobs.submit({
      deduplicationKey: event.aggregate_id,
      kind: 'submission.recognize',
      payload: {
        learningProfileId: event.learning_profile_id,
        processingJobId: event.aggregate_id,
      },
    });
    return true;
  }
  if (event.event_type === 'generated_learning.requested') {
    await clients.aiJobs.submit({
      deduplicationKey: event.aggregate_id,
      kind: 'generated-learning.generate',
      payload: {
        learningProfileId: event.learning_profile_id,
        requestId: event.aggregate_id,
      },
    });
    return true;
  }
  if (event.event_type === 'suggested_assessment.created') {
    await clients.aiJobs.submit({
      deduplicationKey: event.aggregate_id,
      kind: 'open-assessment.generate',
      payload: {
        learningProfileId: event.learning_profile_id,
        suggestionId: event.aggregate_id,
      },
    });
    return true;
  }
  if (event.event_type === 'review_card.generation_requested') {
    await clients.aiJobs.submit({
      deduplicationKey: event.aggregate_id,
      kind: 'review-card.generate',
      payload: {
        learningProfileId: event.learning_profile_id,
        requestId: event.aggregate_id,
      },
    });
    return true;
  }
  return false;
}

async function complete(pool: Pool, eventId: string, succeeded: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_outbox_relay');
    await client.query('SELECT learning.complete_domain_outbox($1,$2)', [eventId, succeeded]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function publishWithProfileFence(
  pool: Pool,
  event: OutboxEvent,
  publish: () => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_outbox_relay');
    const decision = await client.query<{ allowed: boolean }>(
      'SELECT learning.lock_and_check_domain_dispatch($1,$2) AS allowed',
      [event.learning_profile_id, event.event_type],
    );
    if (decision.rows[0]?.allowed) await publish();
    await client.query('COMMIT');
    return Boolean(decision.rows[0]?.allowed);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function relayOutboxBatch(input: {
  pool: Pool;
  publish(event: OutboxEvent): Promise<void>;
}): Promise<{ claimed: number; failed: number; published: number }> {
  const client = await input.pool.connect();
  let events: OutboxEvent[];
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_outbox_relay');
    const result = await client.query<OutboxEvent>(
      'SELECT * FROM learning.claim_domain_outbox(100)',
    );
    events = result.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  let failed = 0;
  let published = 0;
  for (const event of events) {
    let succeeded = false;
    try {
      await input.publish(event);
      succeeded = true;
      published += 1;
    } catch {
      failed += 1;
    }
    await complete(input.pool, event.id, succeeded);
  }
  return { claimed: events.length, failed, published };
}

export function startOutboxRelay(input: {
  databaseUrl: string;
  project?: (event: OutboxEvent) => Promise<void>;
  redisUrl: string;
}) {
  const pool = new Pool({ connectionString: input.databaseUrl });
  const aiJobs = new BullMqJobClient({ queueName: 'rhea-ai', redisUrl: input.redisUrl });
  const safetyJobs = new BullMqJobClient({ queueName: 'rhea-safety', redisUrl: input.redisUrl });
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  async function poll() {
    if (stopped) return;
    try {
      await relayOutboxBatch({
        pool,
        async publish(event) {
          await publishWithProfileFence(pool, event, async () => {
            await input.project?.(event);
            await dispatchOutboxJob(event, { aiJobs, safetyJobs });
          });
        },
      });
    } catch {
      // A failed poll is retried after the bounded interval. Claimed rows have leases.
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    }
  }
  void poll();
  return {
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await aiJobs.close();
      await safetyJobs.close();
      await pool.end();
    },
  };
}
