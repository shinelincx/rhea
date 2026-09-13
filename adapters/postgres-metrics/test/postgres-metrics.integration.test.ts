import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { MetricsGovernanceService } from '@rhea/metrics-governance';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMetricsGovernanceStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

describeWithDatabase('Postgres metrics governance adapter', () => {
  const suffix = randomUUID();
  const pepper = 'metrics-integration-token-pepper-32-bytes';
  const eventToken = (value: string) =>
    createHmac('sha256', pepper).update(`event-key\0${value}`).digest('hex');
  let providerEvaluationId: string | undefined;

  beforeAll(async () => {
    await applyMigrations(
      { query: async (sql, values) => ({ rows: (await pool!.query(sql, values)).rows }) },
      await loadDefaultMigrations(),
    );
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM metrics.governance_operations_audit WHERE reason LIKE $1', [
      `%${suffix}%`,
    ]);
    if (providerEvaluationId) {
      await pool?.query(
        "DELETE FROM metrics.readiness_evidence WHERE key='provider_quality' AND reference=$1",
        [`quality-readiness:${providerEvaluationId}`],
      );
      await pool?.query('DELETE FROM metrics.provider_quality_readiness_evaluations WHERE id=$1', [
        providerEvaluationId,
      ]);
    }
    await pool?.query('DELETE FROM metrics.learning_events WHERE event_key = ANY($1::text[])', [
      [
        eventToken(`event-${suffix}`),
        eventToken(`late-event-${suffix}`),
        eventToken(`racing-event-${suffix}`),
      ],
    ]);
    await pool?.query('DELETE FROM metrics.metric_registry WHERE key=$1', [`metric-${suffix}`]);
    await pool?.query(
      `DELETE FROM metrics.erased_profile_subjects
       WHERE (family_token=$1 AND profile_token=$2)
          OR (family_token=$3 AND profile_token=$4)`,
      [
        createHmac('sha256', pepper).update(`erased-family-${suffix}`).digest('hex'),
        createHmac('sha256', pepper).update(`erased-profile-${suffix}`).digest('hex'),
        createHmac('sha256', pepper).update(`racing-family-${suffix}`).digest('hex'),
        createHmac('sha256', pepper).update(`racing-profile-${suffix}`).digest('hex'),
      ],
    );
    await pool?.end();
  });

  it('stores deidentified, idempotent events behind the metrics-only role', async () => {
    const operator = new MetricsGovernanceService(
      new PostgresMetricsGovernanceStore(pool!, pepper, 'rhea_metrics_operator'),
    );
    await operator.registerMetric(
      {
        denominator: 'eligible',
        exclusions: ['pending'],
        key: `metric-${suffix}`,
        numerator: 'correct',
        owner: 'quality-owner',
        retentionDays: 90,
        version: 'v1',
        windowDays: 30,
      },
      { actorId: 'metrics-operator', reason: `register-${suffix}` },
    );
    const service = new MetricsGovernanceService(new PostgresMetricsGovernanceStore(pool!, pepper));
    const event = {
      authorityState: 'accepted_current' as const,
      eventKey: `event-${suffix}`,
      eventType: 'assessment.accepted',
      familySpaceId: 'family-sensitive',
      learningProfileId: 'profile-sensitive',
      occurredAt: '2026-09-13T08:00:00.000Z',
      payload: { correct: true },
      source: { aggregateId: 'assessment-1', aggregateType: 'assessment', version: '1' },
      version: 'v1',
    };
    expect(await service.recordLearningEvent(event)).toBe('recorded');
    expect(await service.recordLearningEvent(event)).toBe('replayed');
    const stored = await pool!.query(
      'SELECT event_key,family_token,profile_token,source FROM metrics.learning_events WHERE event_key=$1',
      [eventToken(event.eventKey)],
    );
    expect(stored.rows[0]).toMatchObject({
      event_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      family_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      profile_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      source: {
        aggregateId: expect.stringMatching(/^[0-9a-f]{64}$/),
        aggregateType: 'assessment',
        version: '1',
      },
    });
    expect(JSON.stringify(stored.rows)).not.toContain('sensitive');
    expect(JSON.stringify(stored.rows)).not.toContain(event.eventKey);
    expect(JSON.stringify(stored.rows)).not.toContain(event.source.aggregateId);
    expect(
      await service.transitionLearningEventsAuthority({
        authorityState: 'invalidated',
        eventKeys: [event.eventKey],
      }),
    ).toBe(1);
    expect(
      await pool!.query('SELECT authority_state FROM metrics.learning_events WHERE event_key=$1', [
        eventToken(event.eventKey),
      ]),
    ).toMatchObject({ rows: [{ authority_state: 'invalidated' }] });
    const privileges = await pool!.query(
      "SELECT has_schema_privilege('rhea_metrics_app','learning','USAGE') AS learning_access,has_schema_privilege('rhea_metrics_app','safety','USAGE') AS safety_access",
    );
    expect(privileges.rows[0]).toEqual({ learning_access: false, safety_access: false });
  });

  it('rejects every late metric write after the erasure deny marker is committed', async () => {
    const familySpaceId = `erased-family-${suffix}`;
    const learningProfileId = `erased-profile-${suffix}`;
    const familyToken = createHmac('sha256', pepper).update(familySpaceId).digest('hex');
    const profileToken = createHmac('sha256', pepper).update(learningProfileId).digest('hex');
    await pool!.query('SELECT metrics.erase_profile_learning_events($1,$2)', [
      familyToken,
      profileToken,
    ]);
    const service = new MetricsGovernanceService(new PostgresMetricsGovernanceStore(pool!, pepper));
    await expect(
      service.recordLearningEvent({
        authorityState: 'accepted_current',
        eventKey: `late-event-${suffix}`,
        eventType: 'assessment.accepted',
        familySpaceId,
        learningProfileId,
        occurredAt: '2026-09-13T08:00:00.000Z',
        payload: { correct: true },
        source: { aggregateId: 'assessment-late', aggregateType: 'assessment', version: '1' },
        version: 'v1',
      }),
    ).rejects.toThrow('已删除学习档案不得重新写入指标');
  });

  it('serializes metric writes with profile erasure and leaves no late event', async () => {
    const familySpaceId = `racing-family-${suffix}`;
    const learningProfileId = `racing-profile-${suffix}`;
    const familyToken = createHmac('sha256', pepper).update(familySpaceId).digest('hex');
    const profileToken = createHmac('sha256', pepper).update(learningProfileId).digest('hex');
    const lock = await pool!.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `metrics-profile:${familyToken}:${profileToken}`,
    ]);
    const service = new MetricsGovernanceService(new PostgresMetricsGovernanceStore(pool!, pepper));
    let writeSettled = false;
    const write = service
      .recordLearningEvent({
        authorityState: 'accepted_current',
        eventKey: `racing-event-${suffix}`,
        eventType: 'assessment.accepted',
        familySpaceId,
        learningProfileId,
        occurredAt: '2026-09-13T08:00:00.000Z',
        payload: { correct: true },
        source: { aggregateId: 'racing', aggregateType: 'assessment', version: '1' },
        version: 'v1',
      })
      .finally(() => {
        writeSettled = true;
      });
    await delay(100);
    expect(writeSettled).toBe(false);
    const erasure = pool!.query('SELECT metrics.erase_profile_learning_events($1,$2)', [
      familyToken,
      profileToken,
    ]);
    await lock.query('COMMIT');
    lock.release();
    await Promise.all([write, erasure]);
    const remaining = await pool!.query(
      'SELECT count(*)::integer AS count FROM metrics.learning_events WHERE event_key=$1',
      [eventToken(`racing-event-${suffix}`)],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it('derives provider readiness from T09 releases and cannot be bypassed by table DML', async () => {
    const store = new PostgresMetricsGovernanceStore(pool!, pepper, 'rhea_metrics_operator');
    const service = new MetricsGovernanceService(store);
    const evaluation = await service.evaluateProviderQualityReadiness({
      actorId: 'release-manager',
      reason: `provider-readiness-${suffix}`,
    });
    providerEvaluationId = evaluation.id;
    expect(evaluation).toMatchObject({ passed: false });
    expect(evaluation.reasons).toEqual(
      expect.arrayContaining(['缺少当前启用的 OCR 发布', '缺少当前启用的 AI 发布']),
    );
    expect(await service.getProviderQualityReadiness()).toEqual(evaluation);
    const audit = await pool!.query(
      'SELECT action,target FROM metrics.governance_operations_audit WHERE target=$1',
      [evaluation.id],
    );
    expect(audit.rows).toEqual([{ action: 'provider_quality.evaluate', target: evaluation.id }]);
    const authority = await pool!.query(
      `SELECT
         to_regclass('metrics.product_quality_gate_policies') AS duplicate_policy,
         to_regclass('metrics.quality_gate_reports') AS duplicate_report,
         has_table_privilege(
           'rhea_metrics_operator',
           'metrics.provider_quality_readiness_evaluations',
           'INSERT,UPDATE,DELETE'
         ) AS evaluation_dml,
         has_table_privilege(
           'rhea_metrics_operator',
           'metrics.readiness_evidence',
           'INSERT,UPDATE,DELETE'
         ) AS readiness_dml`,
    );
    expect(authority.rows[0]).toEqual({
      duplicate_policy: null,
      duplicate_report: null,
      evaluation_dml: false,
      readiness_dml: false,
    });
    await expect(
      service.saveReadinessEvidence(
        {
          key: 'provider_quality',
          passed: true,
          reference: 'self://approved',
          signedBy: null,
        },
        { actorId: 'release-manager', reason: `forged-${suffix}` },
      ),
    ).rejects.toThrow('供应商质量准入只能由当前发布质量状态生成');
  });
});
