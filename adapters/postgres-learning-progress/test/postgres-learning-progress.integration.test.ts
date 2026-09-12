import { createHash, randomUUID } from 'node:crypto';

import { AssessmentService } from '@rhea/assessment';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { LearningContentService } from '@rhea/learning-content';
import { LearningProgressService, type NewLearningEvidence } from '@rhea/learning-progress';
import { PostgresAssessmentStore } from '@rhea/postgres-assessment';
import { PostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import {
  QualityControlService,
  type CapabilityUseSlice,
  type CapabilityVersion,
  type EvaluationSlice,
  type RequiredSlicePolicy,
} from '@rhea/quality-control';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresLearningProgressStore, PostgresReviewCardStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const reviewUseSlice = {
  basisState: 'current',
  gradeBand: 'middle_primary',
  imageQuality: 'not_applicable',
  questionType: 'objective',
  riskLevel: 'medium',
  subject: 'mathematics',
} satisfies CapabilityUseSlice;
const requiredEvaluationSlices = [
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
] satisfies EvaluationSlice[];
let qualityControl: QualityControlService | undefined;
let reviewCapability: CapabilityVersion | undefined;

async function registerReviewCapability(service: QualityControlService) {
  const suffix = randomUUID();
  const policy: RequiredSlicePolicy = {
    minimumSampleSize: 20,
    registeredAt: '2026-09-11T00:00:00.000Z',
    requiredSignoffRoles: ['quality_owner', 'domain_reviewer', 'child_safety'],
    requiredSlices: requiredEvaluationSlices,
    version: `review-policy-${suffix}`,
  };
  const version: CapabilityVersion = {
    adapter: { id: 'review-card-adapter', version: '1' },
    artifactHash: 'e'.repeat(64),
    capabilityKey: 'ai.review-card',
    id: `review-capability-${suffix}`,
    implementedBy: 'integration-test',
    kind: 'ai',
    modelOrEngine: { id: 'fixed', version: '1' },
    policyVersion: 'child-learning-policy-v1',
    promptOrConfig: { kind: 'prompt', version: 'review-v1' },
    provider: { id: 'fixed', version: '1' },
    region: 'cn-shanghai',
    registeredAt: '2026-09-11T00:00:01.000Z',
    requiredSlicePolicyVersion: policy.version,
    templateVersion: '1',
  };
  await service.registerSlicePolicy({ commandId: `policy-${suffix}`, policy });
  let record = await service.registerCapability({ commandId: `capability-${suffix}`, version });
  for (const [index, slice] of requiredEvaluationSlices.entries()) {
    record = await service.recordEvaluation({
      commandId: `evaluation-${suffix}-${index}`,
      expectedRevision: record.revision,
      run: {
        capabilityVersionId: version.id,
        completedAt: `2026-09-11T00:01:0${index}.000Z`,
        evidenceHash: String(index + 1).repeat(64),
        id: `evaluation-${suffix}-${index}`,
        metrics: { criticalErrorCount: 0, passRate: 1 },
        outcome: 'passed',
        policyVersion: policy.version,
        sampleSize: 100,
        slice,
      },
    });
  }
  const card = await service.getQualityCard(version.id);
  for (const [index, role] of (
    ['quality_owner', 'domain_reviewer', 'child_safety'] as const
  ).entries()) {
    const qualification = await service.signOffCapability({
      capabilityVersionId: version.id,
      commandId: `signoff-${suffix}-${role}`,
      evidenceHash: card.evidenceHash,
      expectedRevision: record.revision,
      policyVersion: policy.version,
      signedAt: `2026-09-11T00:02:0${index}.000Z`,
      signer: { id: `${role}-${suffix}`, role },
    });
    record = await service.getCapability(qualification.capabilityVersionId);
  }
  for (const rollout of [
    { changedAt: '2026-09-11T00:03:00.000Z', percentage: 0, stage: 'shadow' as const },
    { changedAt: '2026-09-11T00:04:00.000Z', percentage: 10, stage: 'small' as const },
    { changedAt: '2026-09-11T00:05:00.000Z', percentage: 50, stage: 'expanded' as const },
    { changedAt: '2026-09-11T00:06:00.000Z', percentage: 100, stage: 'general' as const },
  ]) {
    record = await service.advanceRollout({
      allowedUseSlices: [reviewUseSlice],
      capabilityVersionId: version.id,
      commandId: `rollout-${suffix}-${rollout.stage}`,
      expectedRevision: record.revision,
      ...rollout,
    });
  }
  return version;
}

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
  if (pool) {
    await applyMigrations(pool, await loadDefaultMigrations());
    qualityControl = new QualityControlService(new PostgresQualityControlStore(pool));
    reviewCapability = await registerReviewCapability(qualityControl);
  }
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
      `INSERT INTO learning.family_consents
        (family_space_id, kind, status, statement_version, revision,
         updated_by_guardian_id, updated_at)
       VALUES ($1, 'ai_processing', 'granted', 'ai-v1', 1, $2, now())`,
      [familySpaceId, guardianId],
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
  it('persists a governed review card, bounded session, attempt, outbox, and lineage', async () => {
    if (!pool || !qualityControl || !reviewCapability) return;
    const fixture = await createFixture();
    const captured = (await fixture.progress.captureAcceptedError({
      actor: fixture.actor,
      assessmentId: fixture.graded.id,
      learningProfileId: fixture.learningProfileId,
    }))!;
    const reviewStore = new PostgresReviewCardStore(pool);
    const authorizationDecision = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.review-card',
      familySpaceId: fixture.familySpaceId,
      kind: 'ai',
      slice: reviewUseSlice,
    });
    if (authorizationDecision.status !== 'authorized' || !authorizationDecision.primary) {
      throw new Error('Review-card test capability was not authorized');
    }
    const capabilityVersionId = reviewCapability.id;
    const requestId = randomUUID();
    const createdAt = '2026-09-12T01:00:00.000Z';
    const source = {
      ageBand: 'middle_primary' as const,
      assessmentId: captured.assessment.assessmentId,
      assessmentVersionId: captured.assessment.assessmentVersionId,
      basis: captured.assessment.basis,
      classificationRevision: captured.classification.revision,
      consentRevision: 1,
      gradingRuleVersionId: captured.assessment.correctBasis.gradingRuleVersionId,
      knowledgePointName: captured.classification.primaryKnowledgePointName!,
      originalExpectedAnswer: '42',
      originalQuestion: captured.assessment.question.text,
      originalQuestionContentHash: captured.assessment.question.contentHash,
      originalQuestionVersionId: captured.assessment.question.versionId,
      originalResponse: captured.assessment.response.text,
      originalResponseContentHash: captured.assessment.response.contentHash,
      originalResponseVersionId: captured.assessment.response.versionId,
      subject: 'mathematics' as const,
      themeId: captured.themeId,
      unitName: captured.classification.unitName,
      wrongItemId: captured.id,
      wrongItemStateRevision: captured.stateRevision,
      wrongItemStatus: captured.status,
    };
    const request = {
      actor: fixture.actor,
      authorization: {
        containmentEpoch: authorizationDecision.containmentEpoch,
        decisionId: authorizationDecision.decisionId,
        degradedReason: authorizationDecision.degradedReason,
        issuedAt: authorizationDecision.issuedAt,
      },
      capability: reviewCapability,
      createdAt,
      currentCardId: null,
      familySpaceId: fixture.familySpaceId,
      id: requestId,
      idempotencyKey: 'review-request-1',
      latestChecks: [],
      learningProfileId: fixture.learningProfileId,
      modelRuns: [],
      processingLeaseExpiresAt: null,
      rebuildPending: false,
      requestFingerprint: 'f'.repeat(64),
      source,
      stateRevision: 1,
      status: 'queued' as const,
      unavailableReason: null,
      updatedAt: createdAt,
    };
    await expect(
      reviewStore.authorize({
        ageBand: 'middle_primary',
        consentRevision: 1,
        familySpaceId: fixture.familySpaceId,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);
    await expect(reviewStore.createReviewCardRequest(request)).resolves.toBe(true);
    await expect(reviewStore.createReviewCardRequest(request)).resolves.toBe(false);
    await expect(
      reviewStore.markReviewCardGenerating({
        expectedStateRevision: 1,
        leaseExpiresAt: '2026-09-12T01:01:00.000Z',
        learningProfileId: fixture.learningProfileId,
        requestId,
        updatedAt: createdAt,
      }),
    ).resolves.toBe(true);
    const card = {
      candidate: {
        explanationSteps: ['先算 8 × 5 = 40，再加 2 得到 42。'],
        expectedAnswer: '42',
        gradingRule: { expected: '42', kind: 'numeric' as const },
        keyChanges: ['改成两步乘加运算'],
        methodHint: '先乘后加。',
        orientationHint: '注意运算顺序。',
        question: '8 × 5 + 2 = ?',
      },
      capabilityVersionId,
      checks: [
        { detail: '结构通过', kind: 'schema' as const, passed: true },
        { detail: '变式通过', kind: 'rewrite' as const, passed: true },
      ],
      createdAt,
      familySpaceId: fixture.familySpaceId,
      id: randomUUID(),
      learningProfileId: fixture.learningProfileId,
      requestId,
      schedule: {
        dueAt: '2026-09-12T02:00:00.000Z',
        intervalDays: 1 as const,
        pendingCorrection: true,
        stepIndex: 0 as const,
      },
      source,
      status: 'active' as const,
      version: 1,
    };
    const modelRuns = [
      {
        attempt: 1,
        authorizationDecisionId: authorizationDecision.decisionId,
        capabilityVersionId,
        externalTraceId: 'trace-1',
        finishedAt: createdAt,
        inputTokens: 100,
        observedProvider: reviewCapability.provider.id,
        outputTokens: 100,
        succeeded: true,
      },
    ];
    await expect(
      reviewStore.completeReviewCardRequest({
        card,
        expectedStateRevision: 2,
        modelRuns,
        requestId,
      }),
    ).resolves.toBe('completed');
    const session = {
      cardIds: [card.id],
      createdAt: '2026-09-12T02:01:00.000Z',
      id: randomUUID(),
      learningProfileId: fixture.learningProfileId,
    };
    await expect(reviewStore.createShortReviewSession(session)).resolves.toBe(true);
    const attempt = {
      cardId: card.id,
      createdAt: '2026-09-12T02:02:00.000Z',
      hintLevel: 0 as const,
      id: randomUUID(),
      idempotencyKey: 'review-attempt-1',
      outcome: 'correct' as const,
      perceivedDifficulty: 'hard' as const,
      responseText: '42',
      scheduleAfter: {
        dueAt: '2026-09-15T02:02:00.000Z',
        intervalDays: 3 as const,
        pendingCorrection: false,
        stepIndex: 1 as const,
      },
      scheduleBefore: card.schedule,
      sessionId: session.id,
    };
    const learningEvidence: NewLearningEvidence = {
      answerExposure: 'not_exposed',
      familySpaceId: fixture.familySpaceId,
      hintUsage: 'none',
      id: randomUUID(),
      learningDate: '2026-09-12',
      learningProfileId: fixture.learningProfileId,
      occurredAt: attempt.createdAt,
      outcome: 'correct',
      qualification: 'independent_success',
      recordedAt: attempt.createdAt,
      sourceKind: 'review_card_attempt',
      sourceReferenceId: attempt.id,
      sourceVersions: {
        assessmentVersionId: source.assessmentVersionId,
        basis: {
          contentHash: source.basis.contentHash,
          selectionVersion: source.basis.selectionVersion,
          sourceVersionId: source.basis.sourceVersionId,
          validityEpoch: source.basis.validityEpoch,
        },
        capabilityVersionId,
        classificationRevision: source.classificationRevision,
        gradingRuleVersionId: source.gradingRuleVersionId,
        questionContentHash: source.originalQuestionContentHash,
        questionVersionId: source.originalQuestionVersionId,
        responseContentHash: source.originalResponseContentHash,
        responseVersionId: source.originalResponseVersionId,
        reviewCardId: card.id,
        reviewCardVersion: card.version,
        wrongItemStateRevision: source.wrongItemStateRevision,
      },
      themeId: source.themeId,
      variation: {
        differsFromOriginal: true,
        generationCheckPassed: true,
        kind: 'ai_checked_rewrite',
        questionContentHash: createHash('sha256')
          .update(JSON.stringify(card.candidate.question))
          .digest('hex'),
        sourceQuestionContentHash: source.originalQuestionContentHash,
      },
      wrongItemId: captured.id,
    };
    await expect(
      reviewStore.recordReviewAttempt({
        attempt,
        evidence: learningEvidence,
        expectedSchedule: card.schedule,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);
    await expect(
      reviewStore.recordReviewAttempt({
        attempt,
        evidence: learningEvidence,
        expectedSchedule: card.schedule,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);

    const secondAttempt = {
      ...attempt,
      createdAt: '2026-09-15T02:03:00.000Z',
      id: randomUUID(),
      idempotencyKey: 'review-attempt-2',
      scheduleAfter: {
        dueAt: '2026-09-22T02:03:00.000Z',
        intervalDays: 7 as const,
        pendingCorrection: false,
        stepIndex: 2 as const,
      },
      scheduleBefore: attempt.scheduleAfter,
    };
    await expect(
      reviewStore.recordReviewAttempt({
        attempt: secondAttempt,
        evidence: {
          ...learningEvidence,
          id: randomUUID(),
          learningDate: '2026-09-15',
          occurredAt: secondAttempt.createdAt,
          recordedAt: secondAttempt.createdAt,
          sourceReferenceId: secondAttempt.id,
        },
        expectedSchedule: attempt.scheduleAfter,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);
    await expect(
      reviewStore.findWrongItemThemeMastery(source.themeId, fixture.learningProfileId),
    ).resolves.toMatchObject({
      cycle: 1,
      evidence: expect.arrayContaining([
        expect.objectContaining({ learningDate: '2026-09-12' }),
        expect.objectContaining({ learningDate: '2026-09-15' }),
      ]),
      history: expect.arrayContaining([
        expect.objectContaining({ kind: 'mastered', reason: 'rule_satisfied' }),
      ]),
      status: 'mastered',
    });
    const laterIncorrectAttempt = {
      ...secondAttempt,
      createdAt: '2026-09-16T02:03:00.000Z',
      id: randomUUID(),
      idempotencyKey: 'review-attempt-later-error',
      outcome: 'incorrect' as const,
      responseText: '41',
      scheduleAfter: {
        dueAt: '2026-09-17T02:03:00.000Z',
        intervalDays: 1 as const,
        pendingCorrection: true,
        stepIndex: 0 as const,
      },
      scheduleBefore: secondAttempt.scheduleAfter,
    };
    await expect(
      reviewStore.recordReviewAttempt({
        attempt: laterIncorrectAttempt,
        evidence: {
          ...learningEvidence,
          id: randomUUID(),
          learningDate: '2026-09-16',
          occurredAt: laterIncorrectAttempt.createdAt,
          outcome: 'incorrect',
          qualification: 'incorrect',
          recordedAt: laterIncorrectAttempt.createdAt,
          sourceReferenceId: laterIncorrectAttempt.id,
        },
        expectedSchedule: secondAttempt.scheduleAfter,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);
    await expect(
      reviewStore.findWrongItemThemeMastery(source.themeId, fixture.learningProfileId),
    ).resolves.toMatchObject({
      cycle: 2,
      evidence: expect.arrayContaining([
        expect.objectContaining({ cycle: 2, outcome: 'incorrect' }),
      ]),
      history: expect.arrayContaining([
        expect.objectContaining({ kind: 'reopened', reason: 'new_error' }),
      ]),
      status: 'active',
    });

    await fixture.progress.reviseReason({
      action: 'confirm',
      actor: { id: fixture.guardianId, type: 'guardian' },
      category: captured.reasonCandidate.category,
      expectedStateRevision: captured.stateRevision,
      explanation: captured.reasonCandidate.explanation,
      learningProfileId: fixture.learningProfileId,
      reason: '监护人确认原归因。',
      wrongItemId: captured.id,
    });
    await expect(
      reviewStore.recordReviewAttempt({
        attempt,
        evidence: learningEvidence,
        expectedSchedule: card.schedule,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(false);
    await expect(
      reviewStore.invalidateReviewCard({
        expectedStateRevision: 3,
        learningProfileId: fixture.learningProfileId,
        reason: 'SOURCE_CHANGED',
        requestId,
        updatedAt: '2026-09-15T02:04:00.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      reviewStore.findWrongItemThemeMastery(source.themeId, fixture.learningProfileId),
    ).resolves.toMatchObject({
      cycle: 3,
      history: expect.arrayContaining([
        expect.objectContaining({ kind: 'reopened', reason: 'source_invalidated' }),
      ]),
      status: 'active',
    });
    await expect(
      reviewStore.recordReviewAttempt({
        attempt: {
          ...attempt,
          createdAt: '2026-09-15T02:03:00.000Z',
          id: randomUUID(),
          idempotencyKey: 'review-attempt-after-source-change',
          scheduleAfter: {
            dueAt: '2026-09-22T02:03:00.000Z',
            intervalDays: 7,
            pendingCorrection: false,
            stepIndex: 2,
          },
          scheduleBefore: attempt.scheduleAfter,
        },
        evidence: {
          ...learningEvidence,
          id: randomUUID(),
          learningDate: '2026-09-15',
          occurredAt: '2026-09-15T02:03:00.000Z',
          recordedAt: '2026-09-15T02:03:00.000Z',
          sourceReferenceId: 'review-attempt-after-source-change',
        },
        expectedSchedule: attempt.scheduleAfter,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(false);

    const evidence = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM learning.review_cards WHERE id = $1) AS card_count,
         (SELECT count(*)::integer FROM learning.review_card_attempts WHERE card_id = $1) AS attempt_count,
         (SELECT count(*)::integer FROM learning.learning_evidence
            WHERE theme_id = $2) AS learning_evidence_count,
         (SELECT count(*)::integer FROM learning.theme_mastery_transitions
            WHERE theme_id = $2) AS mastery_transition_count,
         (SELECT count(*)::integer FROM learning.domain_outbox
            WHERE aggregate_id = $1 AND event_type = 'review_card.published') AS publication_events,
         (SELECT count(*)::integer FROM learning.derived_artifacts
            WHERE artifact_kind = 'review_card' AND artifact_id = $1::text) AS lineage_count`,
      [card.id, source.themeId],
    );
    expect(evidence.rows[0]).toEqual({
      attempt_count: 3,
      card_count: 1,
      learning_evidence_count: 4,
      lineage_count: 1,
      mastery_transition_count: 4,
      publication_events: 1,
    });
    await expect(reviewStore.findReviewCardById(card.id, randomUUID())).resolves.toBeNull();
  });

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
         (SELECT count(*)::integer FROM learning.learning_evidence
            WHERE wrong_item_id = $1) AS learning_evidence_count,
         (SELECT count(*)::integer FROM learning.learning_evidence
            WHERE wrong_item_id = $1 AND qualification = 'independent_success')
            AS independent_evidence_count,
         (SELECT count(*)::integer FROM learning.wrong_item_access_audit
            WHERE wrong_item_id = $1) AS audit_count,
         (SELECT count(*)::integer FROM learning.derived_artifacts
            WHERE artifact_kind = 'error_item' AND artifact_id = $1::text) AS lineage_versions`,
      [captured.id],
    );
    expect(evidence.rows[0]).toEqual({
      audit_count: 1,
      correction_count: 1,
      independent_evidence_count: 0,
      item_count: 1,
      learning_evidence_count: 2,
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
