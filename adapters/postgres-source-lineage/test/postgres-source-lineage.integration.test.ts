import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { SourceLineageService } from '@rhea/source-lineage';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSourceLineageStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
});

afterAll(async () => pool?.end());

describeWithDatabase('PostgresSourceLineageStore', () => {
  it('invalidates synchronously and rebuilds with durable idempotent retry state', async () => {
    if (!pool) return;
    const familySpaceId = randomUUID();
    const learningProfileId = randomUUID();
    await pool.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
      familySpaceId,
      '来源链测试家庭',
    ]);
    await pool.query(
      `INSERT INTO learning.learning_profiles
        (id, family_space_id, display_name, grade, pin_hash)
       VALUES ($1, $2, '小禾', 3, 'test-hash')`,
      [learningProfileId, familySpaceId],
    );

    const lineage = new SourceLineageService(new PostgresSourceLineageStore(pool));
    const scope = { familySpaceId, learningProfileId };
    const sourceV1 = await lineage.recordSourceRevision({
      commandId: `source-v1:${learningProfileId}`,
      expected: null,
      occurredAt: '2026-09-10T08:00:00.000Z',
      reason: '初始学习依据',
      source: { ...scope, id: 'material-1', kind: 'current_learning_basis' },
      version: 'basis-v1',
    });
    await lineage.publishArtifact({
      artifact: {
        ...scope,
        id: 'card-1',
        kind: 'review_card',
        rebuildable: true,
        version: 'card-v1',
      },
      commandId: `card-v1:${learningProfileId}`,
      dependencies: [{ source: sourceV1, usage: 'authoritative_input' }],
      expectedPreviousVersion: null,
      occurredAt: '2026-09-10T08:01:00.000Z',
    });
    const sourceV2 = await lineage.recordSourceRevision({
      commandId: `source-v2:${learningProfileId}`,
      expected: { epoch: 1, version: 'basis-v1' },
      occurredAt: '2026-09-10T08:02:00.000Z',
      reason: '监护人修正学习依据',
      source: sourceV1,
      version: 'basis-v2',
    });

    const stale = await lineage.getArtifact({
      ...scope,
      id: 'card-1',
      kind: 'review_card',
      version: 'card-v1',
    });
    expect(stale).toMatchObject({
      artifact: { invalidationEpoch: 1, status: 'stale' },
      freshness: 'stale',
      rebuild: { attempt: 0, status: 'queued' },
    });
    await expect(lineage.requireCurrentArtifact(stale.artifact)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });

    const job = await lineage.claimRebuild({
      leaseUntil: '2026-09-10T08:05:00.000Z',
      now: '2026-09-10T08:03:00.000Z',
      workerId: 'lineage-worker-1',
    });
    await lineage.settleRebuild({
      commandId: `retry-card:${learningProfileId}`,
      errorCode: 'GENERATOR_UNAVAILABLE',
      jobId: job!.id,
      now: '2026-09-10T08:04:00.000Z',
      outcome: 'failed',
      retryAt: '2026-09-10T08:06:00.000Z',
      workerId: 'lineage-worker-1',
    });
    expect(await lineage.getArtifact(stale.artifact)).toMatchObject({
      freshness: 'stale',
      rebuild: { errorCode: 'GENERATOR_UNAVAILABLE', status: 'retry_wait' },
    });

    const retry = await lineage.claimRebuild({
      leaseUntil: '2026-09-10T08:08:00.000Z',
      now: '2026-09-10T08:06:00.000Z',
      workerId: 'lineage-worker-2',
    });
    await lineage.publishArtifact({
      artifact: {
        ...scope,
        id: 'card-1',
        kind: 'review_card',
        rebuildable: true,
        version: 'card-v2',
      },
      commandId: `card-v2:${learningProfileId}`,
      dependencies: [{ source: sourceV2, usage: 'authoritative_input' }],
      expectedPreviousVersion: 'card-v1',
      occurredAt: '2026-09-10T08:07:00.000Z',
    });
    const completion = {
      commandId: `complete-card:${learningProfileId}`,
      jobId: retry!.id,
      now: '2026-09-10T08:07:00.000Z',
      outcome: 'completed' as const,
      replacement: {
        ...scope,
        id: 'card-1',
        kind: 'review_card' as const,
        version: 'card-v2',
      },
      workerId: 'lineage-worker-2',
    };
    await expect(lineage.settleRebuild(completion)).resolves.toBe('completed');
    await expect(lineage.settleRebuild(completion)).resolves.toBe('duplicate');
    await expect(lineage.requireCurrentArtifact(completion.replacement)).resolves.toMatchObject({
      freshness: 'current',
    });
    await expect(lineage.getSourceHistory(sourceV1)).resolves.toMatchObject([
      { epoch: 1, version: 'basis-v1' },
      { epoch: 2, predecessorVersion: 'basis-v1', version: 'basis-v2' },
    ]);

    const isolationProfileId = randomUUID();
    await pool.query(
      `INSERT INTO learning.learning_profiles
        (id, family_space_id, display_name, grade, pin_hash)
       VALUES ($1, $2, '小岚', 3, 'test-hash')`,
      [isolationProfileId, familySpaceId],
    );
    await expect(
      lineage.getArtifact({ ...completion.replacement, learningProfileId: isolationProfileId }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });

    const security = await pool.query<{
      all_profile_tables_force_rls: boolean;
      can_call_internal_advance: boolean;
      can_claim: boolean;
      can_insert_revision: boolean;
    }>(`SELECT
      has_table_privilege(
        'rhea_lineage_runtime', 'learning.source_revisions', 'INSERT'
      ) AS can_insert_revision,
      has_function_privilege(
        'rhea_lineage_runtime',
        'learning.claim_lineage_rebuild(text,timestamptz,timestamptz)',
        'EXECUTE'
      ) AS can_claim,
      has_function_privilege(
        'rhea_lineage_runtime',
        'learning.advance_lineage_source(uuid,uuid,text,text,text,text,timestamptz)',
        'EXECUTE'
      ) AS can_call_internal_advance,
      NOT EXISTS (
        SELECT 1 FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'learning'
          AND class.relname IN (
            'source_heads', 'source_revisions', 'derived_artifacts',
            'derived_artifact_heads', 'derivation_edges', 'rebuild_jobs', 'lineage_outbox'
          )
          AND NOT class.relforcerowsecurity
      ) AS all_profile_tables_force_rls`);
    expect(security.rows[0]).toEqual({
      all_profile_tables_force_rls: true,
      can_call_internal_advance: false,
      can_claim: true,
      can_insert_revision: false,
    });
  });
});
