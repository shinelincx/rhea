import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import {
  QualityControlService,
  type CapabilityRecord,
  type CapabilityUseSlice,
  type CapabilityVersion,
  type EvaluationSlice,
  type RequiredSlicePolicy,
} from '@rhea/quality-control';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresQualityControlStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : undefined;

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
});

afterAll(async () => pool?.end());

const slices: EvaluationSlice[] = [
  {
    basisState: 'current',
    gradeBand: 'lower_primary',
    imageQuality: 'clear',
    questionType: 'objective',
    riskLevel: 'low',
    subject: 'chinese',
  },
  {
    basisState: 'conflicted',
    gradeBand: 'middle_primary',
    imageQuality: 'degraded',
    questionType: 'open_response',
    riskLevel: 'medium',
    subject: 'mathematics',
  },
  {
    basisState: 'insufficient',
    gradeBand: 'upper_primary',
    imageQuality: 'unusable',
    questionType: 'process',
    riskLevel: 'high',
    subject: 'english',
  },
  {
    basisState: 'current',
    gradeBand: 'lower_primary',
    imageQuality: 'clear',
    questionType: 'oral',
    riskLevel: 'medium',
    subject: 'science',
  },
  {
    basisState: 'conflicted',
    gradeBand: 'middle_primary',
    imageQuality: 'degraded',
    questionType: 'science_observation',
    riskLevel: 'high',
    subject: 'chinese',
  },
];

const useSlice: CapabilityUseSlice = {
  basisState: 'unclassified',
  gradeBand: 'unclassified',
  imageQuality: 'unclassified',
  questionType: 'unclassified',
  riskLevel: 'unclassified',
  subject: 'unclassified',
};

describeWithDatabase('PostgreSQL quality-control authority', () => {
  it('enforces gates, atomic containment, privacy-only shadow evidence, and append-only history', async () => {
    if (!pool) return;
    const store = new PostgresQualityControlStore(pool);
    const service = new QualityControlService(store);
    const suffix = randomUUID();
    const policy: RequiredSlicePolicy = {
      minimumSampleSize: 10,
      registeredAt: '2026-09-10T00:00:00.000Z',
      requiredSignoffRoles: ['quality_owner', 'domain_reviewer', 'child_safety'],
      requiredSlices: slices,
      version: `slice-policy-${suffix}`,
    };
    await service.registerSlicePolicy({ commandId: randomUUID(), policy });
    const capabilityVersion: CapabilityVersion = {
      adapter: { id: 'ocr-adapter', version: '1' },
      artifactHash: 'a'.repeat(64),
      capabilityKey: `submission-recognition-${suffix}`,
      id: `ocr-${suffix}`,
      implementedBy: 'implementer-1',
      kind: 'ocr',
      modelOrEngine: { id: 'ocr-engine', version: '1' },
      policyVersion: 'processing-v1',
      promptOrConfig: { kind: 'config', version: '1' },
      provider: { id: `provider-${suffix}`, version: '2026-09' },
      region: 'cn-beijing',
      registeredAt: '2026-09-10T00:00:01.000Z',
      requiredSlicePolicyVersion: policy.version,
      templateVersion: 'template-v1',
    };
    const registrationLock = await pool.connect();
    await registrationLock.query('BEGIN');
    await registrationLock.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${capabilityVersion.capabilityKey}:${capabilityVersion.kind}`,
    ]);
    let registrationSettled = false;
    const registration = service
      .registerCapability({ commandId: randomUUID(), version: capabilityVersion })
      .finally(() => {
        registrationSettled = true;
      });
    try {
      await delay(100);
      expect(registrationSettled).toBe(false);
      const insertedBeforeLockRelease = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM metrics.capability_versions WHERE id = $1`,
        [capabilityVersion.id],
      );
      expect(insertedBeforeLockRelease.rows[0]?.count).toBe('0');
    } finally {
      await registrationLock.query('COMMIT');
      registrationLock.release();
    }
    let record: CapabilityRecord = await registration;

    for (const [index, slice] of slices.entries()) {
      record = await service.recordEvaluation({
        commandId: randomUUID(),
        expectedRevision: record.revision,
        run: {
          capabilityVersionId: record.version.id,
          completedAt: `2026-09-10T00:00:${String(index + 2).padStart(2, '0')}.000Z`,
          evidenceHash: String(index + 1).repeat(64),
          id: `run-${index}-${suffix}`,
          metrics: { accuracy: 0.99 },
          outcome: 'passed',
          policyVersion: policy.version,
          sampleSize: 10,
          slice,
        },
      });
    }
    const card = await service.getQualityCard(record.version.id);
    expect(card.status).toBe('passed');
    for (const [index, role] of (
      ['quality_owner', 'domain_reviewer', 'child_safety'] as const
    ).entries()) {
      await service.signOffCapability({
        capabilityVersionId: record.version.id,
        commandId: randomUUID(),
        evidenceHash: card.evidenceHash,
        expectedRevision: record.revision,
        policyVersion: policy.version,
        signedAt: `2026-09-10T00:01:0${index}.000Z`,
        signer: { id: `${role}-${suffix}`, role },
      });
      record = await service.getCapability(record.version.id);
    }
    const malformedScopeClient = await pool.connect();
    try {
      await malformedScopeClient.query('BEGIN');
      await malformedScopeClient.query('SET LOCAL ROLE rhea_quality_governance');
      await expect(
        malformedScopeClient.query(
          `SELECT metrics.advance_quality_rollout($1, $2::jsonb, $3, $4, $5, $6)`,
          [
            record.version.id,
            {
              allowedUseSlices: [
                {
                  gradeBand: 'unclassified',
                  imageQuality: 'unclassified',
                  questionType: 'unclassified',
                  riskLevel: 'unclassified',
                  subject: 'unclassified',
                },
              ],
              percentage: 0,
              stage: 'shadow',
              updatedAt: '2026-09-10T00:01:30.000Z',
            },
            record.revision,
            randomUUID(),
            '9'.repeat(64),
            'quality-governance',
          ],
        ),
      ).rejects.toThrow(/use slices must be valid/i);
    } finally {
      await malformedScopeClient.query('ROLLBACK');
      malformedScopeClient.release();
    }
    record = await service.advanceRollout({
      allowedUseSlices: [useSlice],
      capabilityVersionId: record.version.id,
      changedAt: '2026-09-10T00:02:00.000Z',
      commandId: randomUUID(),
      expectedRevision: record.revision,
      percentage: 0,
      stage: 'shadow',
    });

    const learningOutboxBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM learning.domain_outbox`,
    );
    const shadowDecision = await service.authorizeCapability({
      capabilityKey: record.version.capabilityKey,
      familySpaceId: `family-${suffix}`,
      kind: 'ocr',
      slice: useSlice,
    });
    expect(shadowDecision.status).toBe('degraded');
    expect(shadowDecision.primary).toBeNull();
    expect(shadowDecision.shadow?.capabilityVersion.id).toBe(record.version.id);
    await service.recordShadowObservation({
      capabilityVersionId: record.version.id,
      commandId: randomUUID(),
      decisionId: shadowDecision.decisionId,
      inputHash: 'b'.repeat(64),
      metrics: { agreement: 0.98 },
      observedAt: '2026-09-10T00:02:01.000Z',
      outputHash: 'c'.repeat(64),
    });
    const learningOutboxAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM learning.domain_outbox`,
    );
    expect(learningOutboxAfter.rows[0]?.count).toBe(learningOutboxBefore.rows[0]?.count);

    for (const rollout of [
      { changedAt: '2026-09-10T00:03:00.000Z', percentage: 5, stage: 'small' as const },
      { changedAt: '2026-09-10T00:04:00.000Z', percentage: 50, stage: 'expanded' as const },
      { changedAt: '2026-09-10T00:05:00.000Z', percentage: 100, stage: 'general' as const },
    ]) {
      record = await service.advanceRollout({
        allowedUseSlices: [useSlice],
        capabilityVersionId: record.version.id,
        commandId: randomUUID(),
        expectedRevision: record.revision,
        ...rollout,
      });
    }
    const decision = await service.authorizeCapability({
      capabilityKey: record.version.capabilityKey,
      familySpaceId: `family-${suffix}`,
      kind: 'ocr',
      slice: useSlice,
    });
    expect(decision.status).toBe('authorized');
    const authorizationStorage = await pool.query<{
      family_space_hash: string;
      public_decision: Record<string, unknown>;
    }>(
      `SELECT
         decision.family_space_hash,
         metrics.read_capability_authorization(decision.id) AS public_decision
       FROM metrics.authorization_decisions AS decision
       WHERE decision.id = $1`,
      [decision.decisionId],
    );
    const expectedFamilySpaceHash = createHash('sha256').update(`family-${suffix}`).digest('hex');
    expect(authorizationStorage.rows[0]?.family_space_hash).toBe(expectedFamilySpaceHash);
    expect(authorizationStorage.rows[0]?.public_decision).not.toHaveProperty('familySpaceHash');
    const familyLockClient = await pool.connect();
    try {
      await familyLockClient.query('BEGIN');
      await familyLockClient.query('SET LOCAL ROLE rhea_quality_runtime');
      const locked = await familyLockClient.query<{
        authorization_id: string;
        capability_version_id: string;
      }>(
        `SELECT * FROM metrics.lock_current_family_capability_authorization(
           $1, $2, $3, $4, $5, $6
         )`,
        [
          decision.decisionId,
          record.version.id,
          decision.containmentEpoch,
          expectedFamilySpaceHash,
          'before_send',
          'primary',
        ],
      );
      expect(locked.rows[0]).toMatchObject({
        authorization_id: decision.decisionId,
        capability_version_id: record.version.id,
      });
      await familyLockClient.query('COMMIT');

      await familyLockClient.query('BEGIN');
      await familyLockClient.query('SET LOCAL ROLE rhea_quality_runtime');
      await expect(
        familyLockClient.query(
          `SELECT * FROM metrics.lock_current_family_capability_authorization(
             $1, $2, $3, $4, $5, $6
           )`,
          [
            decision.decisionId,
            record.version.id,
            decision.containmentEpoch,
            '0'.repeat(64),
            'before_send',
            'primary',
          ],
        ),
      ).rejects.toThrow(/AUTHORIZATION_SCOPE_MISMATCH/);
    } finally {
      await familyLockClient.query('ROLLBACK');
      familyLockClient.release();
    }
    const familyReplayClient = await pool.connect();
    try {
      await familyReplayClient.query('BEGIN');
      await familyReplayClient.query('SET LOCAL ROLE rhea_quality_runtime');
      await expect(
        familyReplayClient.query(
          `SELECT metrics.save_quality_authorization_decision($1::jsonb, $2::jsonb)`,
          [
            decision,
            {
              capabilityRevisions: [],
              containmentEpoch: decision.containmentEpoch,
              familySpaceHash: '0'.repeat(64),
            },
          ],
        ),
      ).rejects.toThrow(/decision id reused with different intent/i);
    } finally {
      await familyReplayClient.query('ROLLBACK');
      familyReplayClient.release();
    }

    const staleRollback = await store.saveContainmentOrder(
      {
        containedAt: '2026-09-10T00:05:30.000Z',
        epoch: 1,
        id: randomUUID(),
        reason: 'stale rollback guard',
        target: { id: record.version.id, kind: 'capability_version' },
      },
      {
        containmentEpoch: 0,
        rollback: {
          decisionId: shadowDecision.decisionId,
          primaryVersionId: record.version.id,
        },
      },
      { aggregateId: record.version.id, commandId: randomUUID(), fingerprint: 'd'.repeat(64) },
    );
    expect(staleRollback).toBe('conflict');
    expect((await store.findContainmentState()).epoch).toBe(0);

    const lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('SET LOCAL ROLE rhea_quality_runtime');
    await lockClient.query(
      `SELECT * FROM metrics.lock_current_capability_authorization($1, $2, $3, $4, $5)`,
      [decision.decisionId, record.version.id, decision.containmentEpoch, 'before_send', 'primary'],
    );
    let containmentSettled = false;
    const containment = service
      .containCapability({
        commandId: randomUUID(),
        containedAt: '2026-09-10T00:06:00.000Z',
        expectedContainmentEpoch: decision.containmentEpoch,
        reason: 'critical quality regression',
        target: { id: record.version.id, kind: 'capability_version' },
      })
      .finally(() => {
        containmentSettled = true;
      });
    await delay(100);
    expect(containmentSettled).toBe(false);
    await lockClient.query('COMMIT');
    lockClient.release();
    const state = await containment;
    expect(state.epoch).toBe(decision.containmentEpoch + 1);

    const revalidated = await service.revalidateAuthorization({
      decisionId: decision.decisionId,
      expectedContainmentEpoch: decision.containmentEpoch,
      phase: 'before_publish',
      route: 'primary',
    });
    expect(revalidated).toMatchObject({ reason: 'CAPABILITY_CONTAINED', status: 'rejected' });
    const degraded = await service.authorizeCapability({
      capabilityKey: record.version.capabilityKey,
      familySpaceId: `family-${suffix}`,
      kind: 'ocr',
      slice: useSlice,
    });
    expect(degraded).toMatchObject({ degradedReason: 'CAPABILITY_CONTAINED', status: 'degraded' });

    const evidenceMutation = pool.query(
      `UPDATE metrics.capability_containments SET reason = 'rewritten' WHERE id = $1`,
      [state.orders.at(-1)?.id],
    );
    await expect(evidenceMutation).rejects.toThrow('append-only');
    const history = await pool.query<{ actions: string[]; events: string[] }>(
      `SELECT
        array_agg(DISTINCT release.action ORDER BY release.action) AS actions,
        (SELECT array_agg(DISTINCT event_type ORDER BY event_type)
         FROM metrics.quality_control_outbox
         WHERE aggregate_id IN ($1, $2)) AS events
       FROM metrics.capability_release_revisions AS release
       WHERE release.capability_key = $3`,
      [record.version.id, state.orders.at(-1)?.id, record.version.capabilityKey],
    );
    expect(history.rows[0]?.actions).toEqual(
      expect.arrayContaining(['advance', 'containment_unavailable', 'registered']),
    );
    expect(history.rows[0]?.events).toContain('capability.contained.v1');

    const rolePrivileges = await pool.query<{
      governance_authorize: boolean;
      governance_register: boolean;
      learning_family_lock: boolean;
      learning_unscoped_lock: boolean;
      runtime_authorize: boolean;
      runtime_register: boolean;
    }>(`SELECT
      has_function_privilege(
        'rhea_quality_governance',
        'metrics.save_quality_authorization_decision(jsonb,jsonb)',
        'EXECUTE'
      ) AS governance_authorize,
      has_function_privilege(
        'rhea_quality_governance',
        'metrics.create_quality_capability(jsonb,text,text)',
        'EXECUTE'
      ) AS governance_register,
      has_function_privilege(
        'rhea_learning_app',
        'metrics.lock_current_family_capability_authorization(text,text,bigint,text,text,text)',
        'EXECUTE'
      ) AS learning_family_lock,
      has_function_privilege(
        'rhea_learning_app',
        'metrics.lock_current_capability_authorization(text,text,bigint,text,text)',
        'EXECUTE'
      ) AS learning_unscoped_lock,
      has_function_privilege(
        'rhea_quality_runtime',
        'metrics.save_quality_authorization_decision(jsonb,jsonb)',
        'EXECUTE'
      ) AS runtime_authorize,
      has_function_privilege(
        'rhea_quality_runtime',
        'metrics.create_quality_capability(jsonb,text,text)',
        'EXECUTE'
      ) AS runtime_register`);
    expect(rolePrivileges.rows[0]).toEqual({
      governance_authorize: false,
      governance_register: true,
      learning_family_lock: true,
      learning_unscoped_lock: false,
      runtime_authorize: true,
      runtime_register: false,
    });

    const bypassClient = await pool.connect();
    try {
      await bypassClient.query('BEGIN');
      await bypassClient.query('SET LOCAL ROLE rhea_quality_runtime');
      await expect(
        bypassClient.query(`DELETE FROM metrics.authorization_decisions WHERE id = $1`, [
          decision.decisionId,
        ]),
      ).rejects.toThrow(/permission denied|row-level security/i);
      await bypassClient.query('ROLLBACK');
      await bypassClient.query('BEGIN');
      await bypassClient.query('SET LOCAL ROLE rhea_quality_governance');
      await expect(
        bypassClient.query(
          `UPDATE metrics.capability_versions SET region = 'cn-other' WHERE id = $1`,
          [record.version.id],
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
      await bypassClient.query('ROLLBACK');
    } finally {
      bypassClient.release();
    }
  }, 30_000);
});
