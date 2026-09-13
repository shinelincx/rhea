import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  dispatchOutboxJob,
  publishWithProfileFence,
  relayOutboxBatch,
  type OutboxEvent,
} from '../src/outbox-relay.js';

describe('outbox job dispatch', () => {
  it.each([
    [
      'submission.recognition_requested',
      'submission.recognize',
      { learningProfileId: 'profile-1', processingJobId: 'aggregate-1' },
    ],
    [
      'generated_learning.requested',
      'generated-learning.generate',
      { learningProfileId: 'profile-1', requestId: 'aggregate-1' },
    ],
    [
      'suggested_assessment.created',
      'open-assessment.generate',
      { learningProfileId: 'profile-1', suggestionId: 'aggregate-1' },
    ],
    [
      'review_card.generation_requested',
      'review-card.generate',
      { learningProfileId: 'profile-1', requestId: 'aggregate-1' },
    ],
  ])('maps %s to a durable AI job', async (eventType, kind, payload) => {
    const aiSubmit = vi.fn(async () => ({ id: 'job-1', status: 'queued' as const }));
    const handled = await dispatchOutboxJob(
      {
        aggregate_id: 'aggregate-1',
        aggregate_type: 'test',
        event_type: eventType,
        family_space_id: 'family-1',
        id: 'event-1',
        learning_profile_id: 'profile-1',
        occurred_at: new Date('2026-09-01T00:00:00.000Z'),
        payload: { status: 'queued' },
      } satisfies OutboxEvent,
      { aiJobs: { submit: aiSubmit }, safetyJobs: { submit: vi.fn() } },
    );

    expect(handled).toBe(true);
    expect(aiSubmit).toHaveBeenCalledWith({ deduplicationKey: 'aggregate-1', kind, payload });
  });

  it('maps privacy requests to the safety queue without a queued payload', async () => {
    const safetySubmit = vi.fn(async () => ({ id: 'job-1', status: 'queued' as const }));
    const handled = await dispatchOutboxJob(
      {
        aggregate_id: 'task-1',
        aggregate_type: 'privacy_task',
        event_type: 'privacy.task.requested',
        family_space_id: 'family-1',
        id: 'event-1',
        learning_profile_id: 'profile-1',
        occurred_at: new Date('2026-09-01T00:00:00.000Z'),
        payload: { kind: 'erasure' },
      } satisfies OutboxEvent,
      { aiJobs: { submit: vi.fn() }, safetyJobs: { submit: safetySubmit } },
    );

    expect(handled).toBe(true);
    expect(safetySubmit).toHaveBeenCalledWith({
      deduplicationKey: 'task-1',
      kind: 'privacy.process',
      payload: { taskId: 'task-1' },
    });
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

describeWithDatabase('transactional outbox relay', () => {
  const familySpaceId = randomUUID();
  const profileId = randomUUID();
  beforeAll(async () => {
    await applyMigrations(
      { query: async (sql, values) => ({ rows: (await pool!.query(sql, values)).rows }) },
      await loadDefaultMigrations(),
    );
    await pool!.query('INSERT INTO learning.family_spaces(id,name) VALUES($1,$2)', [
      familySpaceId,
      '发件箱集成家庭',
    ]);
    await pool!.query(
      "INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash) VALUES($1,$2,'小禾',4,'hash')",
      [profileId, familySpaceId],
    );
  });
  afterAll(async () => {
    await pool?.query('DELETE FROM learning.family_spaces WHERE id=$1', [familySpaceId]);
    await pool?.end();
  });

  it('publishes committed events once and marks the authoritative row complete', async () => {
    const eventId = randomUUID();
    await pool!.query(
      "INSERT INTO learning.domain_outbox(id,family_space_id,learning_profile_id,aggregate_type,aggregate_id,event_type,payload,occurred_at) VALUES($1,$2,$3,'test',$3,'test.committed','{}',now())",
      [eventId, familySpaceId, profileId],
    );
    const publishedIds: string[] = [];
    const publish = vi.fn(async (event: { id: string }) => {
      publishedIds.push(event.id);
    });
    const first = await relayOutboxBatch({ pool: pool!, publish });
    expect(first.published).toBeGreaterThanOrEqual(1);
    expect(publishedIds).toContain(eventId);
    await relayOutboxBatch({ pool: pool!, publish });
    expect(publishedIds.filter((id) => id === eventId)).toHaveLength(1);
    const stored = await pool!.query(
      'SELECT publish_attempts,published_at IS NOT NULL AS published FROM learning.domain_outbox WHERE id=$1',
      [eventId],
    );
    expect(stored.rows[0]).toEqual({ publish_attempts: 1, published: true });
  });

  it('releases a failed event with bounded backoff instead of falsely publishing it', async () => {
    const eventId = randomUUID();
    await pool!.query(
      "INSERT INTO learning.domain_outbox(id,family_space_id,learning_profile_id,aggregate_type,aggregate_id,event_type,payload,occurred_at) VALUES($1,$2,$3,'test',$3,'test.retry','{}',now())",
      [eventId, familySpaceId, profileId],
    );
    const result = await relayOutboxBatch({
      pool: pool!,
      publish: async (event) => {
        if (event.id === eventId) throw new Error('redis unavailable');
      },
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const stored = await pool!.query(
      'SELECT publish_attempts,published_at,next_publish_at>now() AS delayed,lease_until FROM learning.domain_outbox WHERE id=$1',
      [eventId],
    );
    expect(stored.rows[0]).toEqual({
      delayed: true,
      lease_until: null,
      publish_attempts: 1,
      published_at: null,
    });
  });

  it('blocks post-freeze dispatch while preserving the privacy erasure event', async () => {
    const event: OutboxEvent = {
      aggregate_id: randomUUID(),
      aggregate_type: 'generated_learning',
      event_type: 'generated_learning.requested',
      family_space_id: familySpaceId,
      id: randomUUID(),
      learning_profile_id: profileId,
      occurred_at: new Date(),
      payload: { status: 'queued' },
    };
    let published = 0;
    await expect(
      publishWithProfileFence(pool!, event, async () => {
        published += 1;
      }),
    ).resolves.toBe(true);
    await pool!.query('SELECT learning.freeze_profile_for_erasure($1,$2)', [
      familySpaceId,
      profileId,
    ]);
    await expect(
      publishWithProfileFence(pool!, event, async () => {
        published += 1;
      }),
    ).resolves.toBe(false);
    await expect(
      publishWithProfileFence(
        pool!,
        { ...event, event_type: 'privacy.task.requested' },
        async () => {
          published += 1;
        },
      ),
    ).resolves.toBe(true);
    expect(published).toBe(2);
  });
});
