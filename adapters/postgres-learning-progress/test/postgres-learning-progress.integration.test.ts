import { createHash, randomUUID } from 'node:crypto';

import { AssessmentService } from '@rhea/assessment';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { LearningContentService } from '@rhea/learning-content';
import { LearningProgressService } from '@rhea/learning-progress';
import { PostgresAssessmentStore } from '@rhea/postgres-assessment';
import { PostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresLearningProgressStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

const recognitionCapability = {
  adapter: { id: 'learning-progress-fixture', version: 'test-v1' },
  artifactHash: 'd'.repeat(64),
  capabilityKey: 'ocr.learning-progress-fixture',
  id: 'learning-progress-fixture-ocr-v1',
  implementedBy: 'learning-progress-integration-test',
  kind: 'ocr',
  modelOrEngine: { id: 'fixture-engine', version: 'engine-v1' },
  policyVersion: 'fixture-policy-v1',
  promptOrConfig: { kind: 'config', version: 'fixture-config-v1' },
  provider: { id: 'fixture-provider', version: 'provider-v1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-11T08:00:00.000Z',
  requiredSlicePolicyVersion: 'learning-progress-fixture-policy-v1',
  templateVersion: 'not-applicable-v1',
} as const;

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
});

afterAll(async () => pool?.end());

async function createFixture() {
  if (!pool) throw new Error('Database is not configured');
  const familySpaceId = randomUUID();
  const guardianId = randomUUID();
  const learningProfileId = randomUUID();
  const uploadSessionId = randomUUID();
  const processingJobId = randomUUID();
  const candidateId = randomUUID();
  const confirmedContentVersionId = randomUUID();
  const authorizationDecisionId = randomUUID();
  let releaseId = 'learning-progress-fixture-ocr-release-v1';
  const questionRegionId = 'question-1';
  const responseRegionId = 'answer-1';
  const regions = [
    {
      confidence: 0.99,
      id: questionRegionId,
      kind: 'question',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      questionRegionId: null,
      readingOrder: 0,
      text: '6 × 7 = ?',
    },
    {
      confidence: 0.99,
      id: responseRegionId,
      kind: 'answer',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      questionRegionId,
      readingOrder: 1,
      text: '41',
    },
  ];
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
    await setup.query(`SELECT set_config('rhea.guardian_id', $1, true)`, [guardianId]);
    await setup.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
      learningProfileId,
    ]);
    await setup.query(`INSERT INTO learning.guardians (id, identity_subject) VALUES ($1, $2)`, [
      guardianId,
      `learning-progress-test:${guardianId}`,
    ]);
    await setup.query(
      `INSERT INTO learning.family_spaces (id, name) VALUES ($1, '错题库测试家庭')`,
      [familySpaceId],
    );
    await setup.query(
      `INSERT INTO learning.guardian_memberships
        (family_space_id, guardian_id, role, status)
       VALUES ($1, $2, 'managing', 'active')`,
      [familySpaceId, guardianId],
    );
    await setup.query(
      `INSERT INTO learning.learning_profiles
        (id, family_space_id, display_name, grade, pin_hash)
       VALUES ($1, $2, '小禾', 3, 'test-hash')`,
      [learningProfileId, familySpaceId],
    );
    await setup.query(
      `INSERT INTO learning.upload_sessions
        (id, family_space_id, learning_profile_id, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'submitted', now(), now() + interval '1 hour')`,
      [uploadSessionId, familySpaceId, learningProfileId],
    );
    await setup.query(
      `INSERT INTO learning.processing_jobs
        (id, upload_session_id, family_space_id, learning_profile_id, status,
         quality_issues, cancellation_version, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'completed', '[]', 0, 1, now(), now())`,
      [processingJobId, uploadSessionId, familySpaceId, learningProfileId],
    );
    await setup.query(
      `INSERT INTO metrics.quality_gate_policies
        (version, minimum_sample_size, required_signoff_roles, registered_at)
       VALUES ($1, 1, ARRAY['quality_owner', 'domain_reviewer', 'child_safety'], $2)
       ON CONFLICT (version) DO NOTHING`,
      [recognitionCapability.requiredSlicePolicyVersion, recognitionCapability.registeredAt],
    );
    await setup.query(
      `INSERT INTO metrics.capability_versions
        (id, capability_key, kind, implemented_by, provider_id, provider_version,
         model_or_engine_id, model_or_engine_version, adapter_id, adapter_version,
         prompt_or_config_kind, prompt_or_config_version, template_version, policy_version,
         required_slice_policy_version, region, registered_at, artifact_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18)
       ON CONFLICT (id) DO NOTHING`,
      [
        recognitionCapability.id,
        recognitionCapability.capabilityKey,
        recognitionCapability.kind,
        recognitionCapability.implementedBy,
        recognitionCapability.provider.id,
        recognitionCapability.provider.version,
        recognitionCapability.modelOrEngine.id,
        recognitionCapability.modelOrEngine.version,
        recognitionCapability.adapter.id,
        recognitionCapability.adapter.version,
        recognitionCapability.promptOrConfig.kind,
        recognitionCapability.promptOrConfig.version,
        recognitionCapability.templateVersion,
        recognitionCapability.policyVersion,
        recognitionCapability.requiredSlicePolicyVersion,
        recognitionCapability.region,
        recognitionCapability.registeredAt,
        recognitionCapability.artifactHash,
      ],
    );
    const existingRelease = await setup.query<{ id: string }>(
      `SELECT id
       FROM metrics.capability_release_revisions
       WHERE capability_key = $1 AND kind = $2 AND revision = 1`,
      [recognitionCapability.capabilityKey, recognitionCapability.kind],
    );
    if (existingRelease.rows[0]) {
      releaseId = existingRelease.rows[0].id;
    } else {
      await setup.query(
        `INSERT INTO metrics.capability_release_revisions
          (id, capability_key, kind, revision, stage, capability_version_id,
           fallback_version_id, rollout_basis_points, allowed_use_slices, predecessor_id,
           action, reason_code, changed_by, changed_at)
         VALUES ($1, $2, $3, 1, 'general', $4, NULL, 10000, $5, NULL,
                 'advance', 'fixture', 'integration-test', $6)`,
        [
          releaseId,
          recognitionCapability.capabilityKey,
          recognitionCapability.kind,
          recognitionCapability.id,
          JSON.stringify([
            {
              basisState: 'not_applicable',
              gradeBand: 'unclassified',
              imageQuality: 'clear',
              questionType: 'unclassified',
              riskLevel: 'unclassified',
              subject: 'unclassified',
            },
          ]),
          recognitionCapability.registeredAt,
        ],
      );
    }
    await setup.query(
      `INSERT INTO metrics.authorization_decisions
        (id, capability_key, kind, family_space_hash, subject, grade_band, question_type,
         image_quality, risk_level, basis_state, rollout_bucket, containment_epoch,
         primary_release_id, primary_version_id, status, degraded_reason, issued_at)
       VALUES ($1, $2, $3, $4, 'unclassified', 'unclassified', 'unclassified',
               'clear', 'unclassified', 'not_applicable', 0, 0, $5, $6,
               'authorized', NULL, $7)`,
      [
        authorizationDecisionId,
        recognitionCapability.capabilityKey,
        recognitionCapability.kind,
        createHash('sha256').update(familySpaceId).digest('hex'),
        releaseId,
        recognitionCapability.id,
        recognitionCapability.registeredAt,
      ],
    );
    await setup.query(
      `INSERT INTO learning.recognition_candidates
        (id, job_id, family_space_id, learning_profile_id, adapter_version,
         finished_at, source_hash, regions, capability_key, capability_kind,
         capability_version_id, authorization_decision_id,
         authorization_containment_epoch, authorization_family_space_hash,
         capability_snapshot)
       VALUES ($1, $2, $3, $4, 'test-v1', $5, $6, $7::jsonb, $8, $9, $10, $11,
               0, $12, $13)`,
      [
        candidateId,
        processingJobId,
        familySpaceId,
        learningProfileId,
        recognitionCapability.registeredAt,
        'a'.repeat(64),
        JSON.stringify(regions),
        recognitionCapability.capabilityKey,
        recognitionCapability.kind,
        recognitionCapability.id,
        authorizationDecisionId,
        createHash('sha256').update(familySpaceId).digest('hex'),
        JSON.stringify(recognitionCapability),
      ],
    );
    await setup.query(
      `INSERT INTO learning.confirmed_content_versions
        (id, job_id, learning_profile_id, version, source_candidate_id, source_hash,
         regions, confirmed_by_learning_profile_id, confirmed_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $3, now())`,
      [
        confirmedContentVersionId,
        processingJobId,
        learningProfileId,
        candidateId,
        'a'.repeat(64),
        JSON.stringify(regions),
      ],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }
  const learningContent = new LearningContentService({
    store: new PostgresLearningContentStore(pool),
  });
  const material = await learningContent.organizeConfirmedContent({
    actor: { id: learningProfileId, type: 'learner' },
    classification: {
      coursePathName: '三年级当前课程',
      knowledgePointNames: ['乘法'],
      primaryKnowledgePointName: '乘法',
      primarySubject: 'mathematics',
      relatedSubjects: [],
      unitName: '乘法',
    },
    confirmedContentVersion: 1,
    confirmedContentVersionId,
    familySpaceId,
    learningProfileId,
    sourceHash: 'a'.repeat(64),
  });
  const assessmentStore = new PostgresAssessmentStore(pool);
  const assessment = new AssessmentService({
    basisReader: learningContent,
    inputReader: assessmentStore,
    store: assessmentStore,
  });
  const actor = { id: learningProfileId, type: 'learner' as const };
  const graded = await assessment.gradeObjective({
    actor,
    familySpaceId,
    inputReference: {
      confirmedContentVersionId,
      processingJobId,
      questionRegionId,
      responseRegionId,
    },
    learningProfileId,
    materialId: material.id,
  });
  const progressStore = new PostgresLearningProgressStore(pool);
  const progress = new LearningProgressService({
    assessmentReader: assessment,
    learningContextReader: learningContent,
    store: progressStore,
  });
  return {
    actor,
    assessment,
    familySpaceId,
    graded,
    guardianId,
    learningContent,
    learningProfileId,
    material,
    progress,
    progressStore,
  };
}

describeWithDatabase('PostgreSQL learning progress adapter', () => {
  it('persists one traceable wrong item, revisions, correction, audit, and lineage', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const captured = (await fixture.progress.captureAcceptedError({
      actor: fixture.actor,
      assessmentId: fixture.graded.id,
      learningProfileId: fixture.learningProfileId,
    }))!;
    const duplicate = await fixture.progress.captureAcceptedError({
      actor: fixture.actor,
      assessmentId: fixture.graded.id,
      learningProfileId: fixture.learningProfileId,
    });
    expect(duplicate?.id).toBe(captured.id);

    const revised = await fixture.progress.reviseReason({
      action: 'correct',
      actor: { id: fixture.guardianId, type: 'guardian' },
      category: 'comprehension',
      expectedStateRevision: captured.stateRevision,
      explanation: '可能漏看了乘号。',
      learningProfileId: fixture.learningProfileId,
      reason: '监护人核对纸面过程。',
      wrongItemId: captured.id,
    });
    const corrected = await fixture.progress.submitImmediateCorrection({
      actor: fixture.actor,
      expectedStateRevision: revised.stateRevision,
      idempotencyKey: 'correction-1',
      learningProfileId: fixture.learningProfileId,
      responseText: '42',
      wrongItemId: captured.id,
    });
    await fixture.progress.getWrongItem({
      actor: fixture.actor,
      learningProfileId: fixture.learningProfileId,
      wrongItemId: captured.id,
    });

    expect(corrected).toMatchObject({
      assessment: {
        correctBasis: { expectedDisplay: '42' },
        question: { text: '6 × 7 = ?' },
        response: { text: '41' },
      },
      correctionAttempts: [{ outcome: 'correct', responseText: '42' }],
      currentReason: { category: 'comprehension', status: 'corrected' },
      firstIncorrectAt: fixture.graded.currentVersion.createdAt,
      status: 'pending_consolidation',
    });
    const evidence = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM learning.wrong_items WHERE id = $1) AS item_count,
         (SELECT count(*)::integer FROM learning.wrong_item_reason_revisions
            WHERE wrong_item_id = $1) AS reason_count,
         (SELECT count(*)::integer FROM learning.immediate_correction_attempts
            WHERE wrong_item_id = $1) AS correction_count,
         (SELECT count(*)::integer FROM learning.wrong_item_access_audit
            WHERE wrong_item_id = $1) AS audit_count,
         (SELECT count(*)::integer FROM learning.derived_artifacts
            WHERE artifact_kind = 'error_item' AND artifact_id = $1::text) AS lineage_versions`,
      [captured.id],
    );
    expect(evidence.rows[0]).toEqual({
      audit_count: 1,
      correction_count: 1,
      item_count: 1,
      lineage_versions: 3,
      reason_count: 1,
    });
  });

  it('fails closed under a dispute and enforces profile and role isolation', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const captured = (await fixture.progress.captureAcceptedError({
      actor: fixture.actor,
      assessmentId: fixture.graded.id,
      learningProfileId: fixture.learningProfileId,
    }))!;
    await fixture.assessment.raiseDispute({
      actor: fixture.actor,
      assessmentId: fixture.graded.id,
      correctionText: '图片里可能写的是 42。',
      learningProfileId: fixture.learningProfileId,
      reason: '作答识别可能有误',
      target: 'response',
    });
    await expect(
      fixture.progress.listWrongItems({
        actor: fixture.actor,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toEqual({ items: [], themes: [] });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_learning_progress_app');
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        fixture.familySpaceId,
      ]);
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      const staleRevision = await client.query<{ revised: boolean }>(
        `SELECT learning.revise_wrong_item_reason($1::jsonb) AS revised`,
        [
          JSON.stringify({
            expectedStateRevision: captured.stateRevision,
            learningProfileId: fixture.learningProfileId,
            revision: {
              action: 'confirm',
              actor: fixture.actor,
              category: captured.reasonCandidate.category,
              changedAt: '2026-09-11T10:00:00.000Z',
              explanation: captured.reasonCandidate.explanation,
              id: randomUUID(),
              reason: null,
              revision: 1,
            },
            updatedAt: '2026-09-11T10:00:00.000Z',
            wrongItemId: captured.id,
          }),
        ],
      );
      expect(staleRevision.rows[0]?.revised).toBe(false);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(fixture.progressStore.findById(captured.id, randomUUID())).resolves.toBeNull();

    const privileges = await pool.query(
      `SELECT
         has_table_privilege(
           'rhea_learning_progress_app', 'learning.wrong_items', 'INSERT'
         ) AS can_insert_wrong_item,
         has_table_privilege(
           'rhea_learning_progress_app', 'learning.objective_assessments', 'SELECT'
         ) AS can_read_assessment_directly,
         has_function_privilege(
           'rhea_learning_progress_app', 'learning.create_wrong_item(jsonb)', 'EXECUTE'
         ) AS can_create_wrong_item,
         has_function_privilege(
           'rhea_learning_progress_app',
           'learning.lock_current_wrong_item(learning.wrong_items)', 'EXECUTE'
         ) AS can_call_internal_lock,
         has_schema_privilege('rhea_learning_progress_app', 'safety', 'USAGE') AS can_use_safety`,
    );
    expect(privileges.rows[0]).toEqual({
      can_create_wrong_item: true,
      can_call_internal_lock: false,
      can_insert_wrong_item: false,
      can_read_assessment_directly: false,
      can_use_safety: false,
    });
  });
});
