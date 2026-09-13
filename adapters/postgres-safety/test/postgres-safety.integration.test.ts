import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { SafetyEscalationService } from '@rhea/safety-escalation';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalSafetyFieldProtector, PostgresSafetyEscalationStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

describeWithDatabase('Postgres safety adapter', () => {
  const familySpaceId = randomUUID();
  const guardianId = randomUUID();
  const missingGrantId = randomUUID();
  const profileId = randomUUID();
  const relaySourceReferenceToken = 'a'.repeat(64);
  let classificationId: string | null = null;
  let safetyCaseId: string | null = null;
  beforeAll(async () => {
    await applyMigrations(
      {
        query: async (sql, values) => {
          const result = await pool!.query(sql, values);
          return { rows: result.rows };
        },
      },
      await loadDefaultMigrations(),
    );
    await pool!.query('INSERT INTO learning.guardians(id,identity_subject) VALUES($1,$2)', [
      guardianId,
      `safety-integration-${guardianId}`,
    ]);
    await pool!.query('INSERT INTO learning.family_spaces(id,name) VALUES($1,$2)', [
      familySpaceId,
      'Safety integration family',
    ]);
    await pool!.query(
      `INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash)
       VALUES($1,$2,'Learner',4,'not-a-real-pin-hash')`,
      [profileId, familySpaceId],
    );
  });
  afterAll(async () => {
    await pool?.query(
      'DELETE FROM safety.case_notifications WHERE case_id IN (SELECT id FROM safety.cases WHERE source_reference_id=$1)',
      [relaySourceReferenceToken],
    );
    await pool?.query('DELETE FROM safety.cases WHERE source_reference_id=$1', [
      relaySourceReferenceToken,
    ]);
    await pool?.query('DELETE FROM safety.classification_events WHERE source_reference_id=$1', [
      relaySourceReferenceToken,
    ]);
    await pool?.query(
      'DELETE FROM safety.challenge_report_classification_outbox WHERE source_reference_id=$1',
      [relaySourceReferenceToken],
    );
    if (safetyCaseId) {
      await pool?.query('DELETE FROM safety.case_queue_access_audit WHERE $1=ANY(case_ids)', [
        safetyCaseId,
      ]);
      await pool?.query('DELETE FROM safety.case_operation_audit WHERE case_id=$1', [safetyCaseId]);
    }
    await pool?.query(
      'DELETE FROM safety.support_access_audit WHERE grant_id=$1 OR grant_id IN (SELECT id FROM safety.support_access_grants WHERE family_space_id=$2)',
      [missingGrantId, familySpaceId],
    );
    await pool?.query('DELETE FROM safety.support_access_grants WHERE family_space_id=$1', [
      familySpaceId,
    ]);
    if (safetyCaseId) {
      await pool?.query('DELETE FROM safety.case_notifications WHERE case_id=$1', [safetyCaseId]);
      await pool?.query('DELETE FROM safety.cases WHERE id=$1', [safetyCaseId]);
    }
    if (classificationId) {
      await pool?.query('DELETE FROM safety.classification_events WHERE id=$1', [classificationId]);
    }
    await pool?.query('DELETE FROM learning.family_spaces WHERE id=$1', [familySpaceId]);
    await pool?.query('DELETE FROM learning.guardians WHERE id=$1', [guardianId]);
    await pool?.end();
  });

  it('retries a durable deidentified challenge report after safety encryption recovers', async () => {
    const outboxId = randomUUID();
    const localProtector = new LocalSafetyFieldProtector(
      'integration-safety-key',
      'integration-safety-field-secret-at-least-32-bytes',
    );
    let kmsAvailable = false;
    const store = new PostgresSafetyEscalationStore(
      pool!,
      'rhea_safety_worker',
      'integration-safety-token-pepper-at-least-32-bytes',
      {
        protect: (plaintext) => {
          if (!kmsAvailable) throw new Error('KMS_UNAVAILABLE');
          return localProtector.protect(plaintext);
        },
      },
    );
    await pool!.query(
      `INSERT INTO safety.challenge_report_classification_outbox(
         id,subject_token,source_reference_id,report_reason,age_band,created_at
       ) VALUES($1,$2,$3,'uncomfortable','middle_primary',now())`,
      [outboxId, 'b'.repeat(64), relaySourceReferenceToken],
    );

    await expect(store.processChallengeReportClassifications()).resolves.toEqual({
      claimed: 1,
      failed: 1,
      processed: 0,
    });
    expect(
      (
        await pool!.query(
          'SELECT status,attempts,lease_until FROM safety.challenge_report_classification_outbox WHERE id=$1',
          [outboxId],
        )
      ).rows[0],
    ).toEqual({ attempts: 1, lease_until: null, status: 'pending' });

    kmsAvailable = true;
    await pool!.query(
      "UPDATE safety.challenge_report_classification_outbox SET next_attempt_at='-infinity' WHERE id=$1",
      [outboxId],
    );
    await expect(store.processChallengeReportClassifications()).resolves.toEqual({
      claimed: 1,
      failed: 0,
      processed: 1,
    });
    expect(
      (
        await pool!.query(
          `SELECT outbox.status,outbox.attempts,count(cases.id)::integer AS cases
           FROM safety.challenge_report_classification_outbox outbox
           LEFT JOIN safety.cases cases ON cases.source_reference_id=outbox.source_reference_id
           WHERE outbox.id=$1 GROUP BY outbox.status,outbox.attempts`,
          [outboxId],
        )
      ).rows[0],
    ).toEqual({ attempts: 2, cases: 1, status: 'completed' });
  });

  it('persists minimal safety records and audited support decisions in the isolated schema', async () => {
    const service = new SafetyEscalationService(new PostgresSafetyEscalationStore(pool!), {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    const result = await service.classify({
      content: '有人要我私下见面并告诉他学校和班级',
      familySpaceId,
      learningProfileId: profileId,
      source: 'challenge_event',
      sourceReferenceId: 'report-1',
    });
    expect(result).toMatchObject({ action: 'escalate', category: 'unsafe_contact' });
    classificationId = result.classificationId;
    safetyCaseId = result.caseId;
    const classification = await pool!.query(
      `SELECT family_space_id,learning_profile_id,source_reference_id,source_hash,
              subject_token,protected_context,protection_key_id,category,severity
       FROM safety.classification_events WHERE id=$1`,
      [result.classificationId],
    );
    expect(classification.rows[0]).toMatchObject({
      category: 'unsafe_contact',
      family_space_id: null,
      learning_profile_id: null,
      protected_context: expect.any(Buffer),
      protection_key_id: 'local-safety-key',
      severity: 'high',
      source_reference_id: expect.stringMatching(/^[0-9a-f]{64}$/),
      source_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      subject_token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const persistedSafetyJson = JSON.stringify(classification.rows);
    expect(persistedSafetyJson).not.toContain('私下见面');
    expect(persistedSafetyJson).not.toContain(familySpaceId);
    expect(persistedSafetyJson).not.toContain(profileId);
    expect(persistedSafetyJson).not.toContain('report-1');

    const operator = new SafetyEscalationService(
      new PostgresSafetyEscalationStore(pool!, 'rhea_safety_operator'),
      { now: new Date('2026-09-13T08:05:00.000Z') },
    );
    const actionable = await operator.listActionableCases({
      operatorId: 'child-safety-operator',
      reason: '读取待处置安全个案',
    });
    expect(actionable).toEqual([
      expect.objectContaining({
        familySpaceId: expect.stringMatching(/^[0-9a-f]{64}$/),
        id: result.caseId,
        learningProfileId: expect.stringMatching(/^[0-9a-f]{64}$/),
        notificationStatus: 'pending',
        sourceReferenceId: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(JSON.stringify(actionable)).not.toContain(familySpaceId);
    expect(JSON.stringify(actionable)).not.toContain(profileId);
    expect(JSON.stringify(actionable)).not.toContain('report-1');
    await operator.operateCase({
      action: 'claim',
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000011',
      operatorId: 'child-safety-operator',
      reason: '领取待处置安全个案',
    });
    await operator.markEscalationFailure({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000012',
      operatorId: 'child-safety-operator',
      reason: '人工升级通道暂时不可用',
    });
    await operator.retryEscalation({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000013',
      operatorId: 'child-safety-operator',
      reason: '人工升级通道恢复',
    });
    await operator.resolveCase({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000014',
      falsePositive: true,
      operatorId: 'child-safety-operator',
      reason: '复核确认语境误报',
    });
    await operator.resolveCase({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000014',
      falsePositive: true,
      operatorId: 'child-safety-operator',
      reason: '复核确认语境误报',
    });
    const queueAudit = await pool!.query(
      'SELECT operator_id,result_count,reason FROM safety.case_queue_access_audit WHERE $1=ANY(case_ids)',
      [result.caseId],
    );
    expect(queueAudit.rows).toEqual([
      {
        operator_id: 'child-safety-operator',
        reason: '读取待处置安全个案',
        result_count: 1,
      },
    ]);
    const caseAudit = await pool!.query(
      'SELECT action,applied FROM safety.case_operation_audit WHERE case_id=$1 ORDER BY id',
      [result.caseId],
    );
    expect(caseAudit.rows).toEqual([
      { action: 'claim', applied: true },
      { action: 'escalation_failed', applied: true },
      { action: 'retry_started', applied: true },
      { action: 'false_positive', applied: true },
    ]);

    const grant = await service.grantSupportAccess({
      allowedRecordIds: [],
      createdByGuardianId: guardianId,
      durationMinutes: 30,
      familySpaceId,
      learningProfileId: profileId,
      reason: '协助处理一次举报',
      scopes: ['processing_status'],
      supportPrincipalId: 'support-1',
    });
    await service.authorizeSupportOperation({
      action: 'view_status',
      familySpaceId,
      grantId: grant.id,
      scope: 'processing_status',
      supportPrincipalId: 'support-1',
    });
    await expect(
      service.authorizeSupportOperation({
        action: 'view_status',
        familySpaceId,
        grantId: missingGrantId,
        scope: 'processing_status',
        supportPrincipalId: 'support-1',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'not_found' });
    const audit = await pool!.query(
      'SELECT grant_id::text,allowed FROM safety.support_access_audit WHERE grant_id IN ($1,$2) ORDER BY allowed DESC',
      [grant.id, missingGrantId],
    );
    expect(audit.rows).toEqual([
      { allowed: true, grant_id: grant.id },
      { allowed: false, grant_id: missingGrantId },
    ]);
    const privileges = await pool!.query(
      "SELECT has_schema_privilege('rhea_learning_progress_app','safety','USAGE') AS learning_can_use_safety",
    );
    expect(privileges.rows[0]).toEqual({ learning_can_use_safety: false });
  });
});
