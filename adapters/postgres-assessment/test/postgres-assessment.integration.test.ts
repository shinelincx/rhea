import { createHash, randomUUID } from 'node:crypto';

import {
  AssessmentService,
  SuggestedAssessmentService,
  type ObjectiveGradingRule,
  type OpenAssessmentTaskType,
} from '@rhea/assessment';
import type { AuthorizationDecision, CapabilityVersion } from '@rhea/quality-control';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { LearningContentService, type Subject } from '@rhea/learning-content';
import { PostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { syncSourceRevisionInTransaction } from '@rhea/postgres-source-lineage';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAssessmentStore, PostgresSuggestedAssessmentStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

const recognitionCapability = {
  adapter: { id: 'assessment-fixture', version: 'test-v1' },
  artifactHash: 'e'.repeat(64),
  capabilityKey: 'ocr.assessment-fixture',
  id: 'assessment-fixture-ocr-v1',
  implementedBy: 'assessment-integration-test',
  kind: 'ocr',
  modelOrEngine: { id: 'fixture-engine', version: 'engine-v1' },
  policyVersion: 'fixture-policy-v1',
  promptOrConfig: { kind: 'config', version: 'fixture-config-v1' },
  provider: { id: 'fixture-provider', version: 'provider-v1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-10T08:00:00.000Z',
  requiredSlicePolicyVersion: 'assessment-fixture-policy-v1',
  templateVersion: 'not-applicable-v1',
} as const;
const recognitionReleaseId = 'assessment-fixture-ocr-release-v1';
const openAssessmentCapability: CapabilityVersion = {
  adapter: { id: 'open-assessment-fixture', version: 'test-v1' },
  artifactHash: 'f'.repeat(64),
  capabilityKey: 'ai.open-assessment-suggestion',
  id: 'open-assessment-fixture-v1',
  implementedBy: 'assessment-integration-test',
  kind: 'ai',
  modelOrEngine: { id: 'fixture-model', version: 'model-v1' },
  policyVersion: 'fixture-policy-v1',
  promptOrConfig: { kind: 'prompt', version: 'open-assessment-prompt-v1' },
  provider: { id: 'fixture-provider', version: 'provider-v1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-10T08:00:00.000Z',
  requiredSlicePolicyVersion: 'open-assessment-fixture-policy-v1',
  templateVersion: 'open-assessment-template-v1',
};
const openAssessmentReleaseId = 'open-assessment-fixture-release-v1';

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
});

afterAll(async () => pool?.end());

async function createLearningMaterial(
  input: {
    answerText?: string;
    knowledgePointName?: string;
    questionText?: string;
    subject?: Subject;
  } = {},
) {
  if (!pool) throw new Error('Database is not configured');
  const subject = input.subject ?? 'mathematics';
  const knowledgePointName = input.knowledgePointName ?? '乘法';
  const familySpaceId = randomUUID();
  const guardianId = randomUUID();
  const learningProfileId = randomUUID();
  const uploadSessionId = randomUUID();
  const processingJobId = randomUUID();
  const candidateId = randomUUID();
  const confirmedContentVersionId = randomUUID();
  const authorizationDecisionId = randomUUID();
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
      text: input.questionText ?? '6 × 7 = ?',
    },
    {
      confidence: 0.99,
      id: 'question-2',
      kind: 'question',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      questionRegionId: null,
      readingOrder: 1,
      text: '第二道题',
    },
    {
      confidence: 0.99,
      id: responseRegionId,
      kind: 'answer',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      questionRegionId,
      readingOrder: 2,
      text: input.answerText ?? '41',
    },
  ];
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
    await setup.query(`SELECT set_config('rhea.guardian_id', $1, true)`, [guardianId]);
    await setup.query(`INSERT INTO learning.guardians (id, identity_subject) VALUES ($1, $2)`, [
      guardianId,
      `assessment-test:${guardianId}`,
    ]);
    await setup.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
      familySpaceId,
      '客观题批改测试家庭',
    ]);
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
    await setup.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
      learningProfileId,
    ]);
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
    await setup.query(
      `INSERT INTO metrics.capability_release_revisions
        (id, capability_key, kind, revision, stage, capability_version_id,
         fallback_version_id, rollout_basis_points, allowed_use_slices, predecessor_id,
         action, reason_code, changed_by, changed_at)
       VALUES ($1, $2, $3, 1, 'general', $4, NULL, 10000, $5, NULL,
               'advance', 'fixture', 'integration-test', $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        recognitionReleaseId,
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
        recognitionReleaseId,
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
      knowledgePointNames: [knowledgePointName],
      primaryKnowledgePointName: knowledgePointName,
      primarySubject: subject,
      relatedSubjects: [],
      unitName: knowledgePointName,
    },
    confirmedContentVersion: 1,
    confirmedContentVersionId,
    familySpaceId,
    learningProfileId,
    sourceHash: 'a'.repeat(64),
  });
  return {
    confirmedContentVersionId,
    familySpaceId,
    learningContent,
    learningProfileId,
    material,
    processingJobId,
    questionRegionId,
    responseRegionId,
  };
}

async function authorizeOpenAssessment(familySpaceId: string, subject: Subject) {
  if (!pool) throw new Error('Database is not configured');
  const decisionId = randomUUID();
  const familySpaceHash = createHash('sha256').update(familySpaceId).digest('hex');
  const epochResult = await pool.query<{ containment_epoch: string }>(
    'SELECT containment_epoch FROM metrics.quality_control_epoch WHERE singleton',
  );
  const containmentEpoch = Number(epochResult.rows[0]!.containment_epoch);
  const slice = {
    basisState: 'current' as const,
    gradeBand: 'middle_primary' as const,
    imageQuality: 'not_applicable' as const,
    questionType: subject === 'mathematics' ? ('process' as const) : ('open_response' as const),
    riskLevel: 'medium' as const,
    subject,
  };
  const setup = await pool.connect();
  await setup.query('BEGIN');
  try {
    await setup.query(
      `INSERT INTO metrics.quality_gate_policies
        (version, minimum_sample_size, required_signoff_roles, registered_at)
       VALUES ($1, 1, ARRAY['quality_owner', 'domain_reviewer', 'child_safety'], $2)
       ON CONFLICT (version) DO NOTHING`,
      [openAssessmentCapability.requiredSlicePolicyVersion, openAssessmentCapability.registeredAt],
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
        openAssessmentCapability.id,
        openAssessmentCapability.capabilityKey,
        openAssessmentCapability.kind,
        openAssessmentCapability.implementedBy,
        openAssessmentCapability.provider.id,
        openAssessmentCapability.provider.version,
        openAssessmentCapability.modelOrEngine.id,
        openAssessmentCapability.modelOrEngine.version,
        openAssessmentCapability.adapter.id,
        openAssessmentCapability.adapter.version,
        openAssessmentCapability.promptOrConfig.kind,
        openAssessmentCapability.promptOrConfig.version,
        openAssessmentCapability.templateVersion,
        openAssessmentCapability.policyVersion,
        openAssessmentCapability.requiredSlicePolicyVersion,
        openAssessmentCapability.region,
        openAssessmentCapability.registeredAt,
        openAssessmentCapability.artifactHash,
      ],
    );
    await setup.query(
      `INSERT INTO metrics.capability_release_revisions
        (id, capability_key, kind, revision, stage, capability_version_id,
         fallback_version_id, rollout_basis_points, allowed_use_slices, predecessor_id,
         action, reason_code, changed_by, changed_at)
       VALUES ($1, $2, $3, 1, 'general', $4, NULL, 10000, $5, NULL,
               'advance', 'fixture', 'integration-test', $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        openAssessmentReleaseId,
        openAssessmentCapability.capabilityKey,
        openAssessmentCapability.kind,
        openAssessmentCapability.id,
        JSON.stringify([slice]),
        openAssessmentCapability.registeredAt,
      ],
    );
    await setup.query(
      `INSERT INTO metrics.capability_current_releases
        (capability_key, kind, primary_release_id, shadow_release_id,
         containment_epoch, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5)
       ON CONFLICT (capability_key, kind) DO UPDATE SET
         primary_release_id = EXCLUDED.primary_release_id,
         shadow_release_id = NULL,
         containment_epoch = EXCLUDED.containment_epoch,
         updated_at = EXCLUDED.updated_at`,
      [
        openAssessmentCapability.capabilityKey,
        openAssessmentCapability.kind,
        openAssessmentReleaseId,
        containmentEpoch,
        openAssessmentCapability.registeredAt,
      ],
    );
    await setup.query(
      `INSERT INTO metrics.authorization_decisions
        (id, capability_key, kind, family_space_hash, subject, grade_band, question_type,
         image_quality, risk_level, basis_state, rollout_bucket, containment_epoch,
         primary_release_id, primary_version_id, status, degraded_reason, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'middle_primary', $6,
               'not_applicable', 'medium', 'current', 0, $7, $8, $9,
               'authorized', NULL, $10)`,
      [
        decisionId,
        openAssessmentCapability.capabilityKey,
        openAssessmentCapability.kind,
        familySpaceHash,
        subject,
        slice.questionType,
        containmentEpoch,
        openAssessmentReleaseId,
        openAssessmentCapability.id,
        openAssessmentCapability.registeredAt,
      ],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }
  const decision: AuthorizationDecision = {
    containmentEpoch,
    decisionId,
    degradedReason: null,
    issuedAt: openAssessmentCapability.registeredAt,
    primary: { capabilityVersion: openAssessmentCapability, rolloutStage: 'general' },
    rolloutBucket: 0,
    scope: {
      capabilityKey: openAssessmentCapability.capabilityKey,
      kind: 'ai',
      slice,
    },
    shadow: null,
    status: 'authorized',
  };
  return decision;
}

describeWithDatabase('PostgreSQL assessment adapter', () => {
  it.each<Array<{ subject: Subject; taskType: OpenAssessmentTaskType }>[number]>([
    { subject: 'chinese', taskType: 'chinese_expression' },
    { subject: 'mathematics', taskType: 'mathematics_process' },
    { subject: 'english', taskType: 'english_expression' },
    { subject: 'science', taskType: 'science_inquiry' },
  ])(
    'resolves the professionally reviewed $subject open-assessment rubric',
    async ({ subject, taskType }) => {
      if (!pool) return;
      const fixture = await createLearningMaterial({
        answerText: '我先观察叶片，然后记录颜色变化，并说明前后差别。',
        knowledgePointName: '开放表达',
        questionText: '请说明你的观察和理由。',
        subject,
      });
      const actor = { id: fixture.learningProfileId, type: 'learner' as const };
      const basis = await fixture.learningContent.getCurrentBasisReference({
        actor,
        learningProfileId: fixture.learningProfileId,
        materialId: fixture.material.id,
      });
      const store = new PostgresSuggestedAssessmentStore(pool);

      const resolved = await store.resolveOpenAssessmentInput({
        actor,
        ageBand: 'middle_primary',
        basis,
        learningProfileId: fixture.learningProfileId,
        materialId: fixture.material.id,
        reference: {
          confirmedContentVersionId: fixture.confirmedContentVersionId,
          processingJobId: fixture.processingJobId,
          questionRegionId: fixture.questionRegionId,
          responseRegionId: fixture.responseRegionId,
        },
        taskType,
      });

      expect(resolved).toMatchObject({
        question: { subject },
        rubric: {
          ageBand: 'middle_primary',
          source: { authority: 'rhea_professionally_reviewed' },
          subject,
          taskType,
          version: '2.0.0',
        },
      });
      expect(resolved?.rubric?.dimensions.length).toBeGreaterThanOrEqual(2);
    },
  );

  it('atomically publishes only a human-accepted suggestion with immutable provenance', async () => {
    if (!pool) return;
    const fixture = await createLearningMaterial({
      answerText: '我先观察叶片，然后记录颜色变化，并说明前后差别。',
      knowledgePointName: '科学观察',
      questionText: '请说明你的观察和理由。',
      subject: 'science',
    });
    const actor = { id: fixture.learningProfileId, type: 'learner' as const };
    const decision = await authorizeOpenAssessment(fixture.familySpaceId, 'science');
    const store = new PostgresSuggestedAssessmentStore(pool);
    const service = new SuggestedAssessmentService({
      basisReader: fixture.learningContent,
      inputReader: store,
      modelGateway: {
        async runStructured(task) {
          return {
            candidate: {
              confidence: 0.93,
              dimensions: task.rubric.dimensions.map(({ key }, index) => ({
                confidence: 0.91,
                dimensionKey: key,
                evidenceExcerpt: index === 0 ? '观察叶片' : '说明前后差别',
                improvementSuggestion: `补充${key}的具体细节。`,
                observation: `作答呈现了${key}证据。`,
                state: index === 0 ? 'demonstrated' : 'partially_demonstrated',
              })),
              improvementDimensionKey: task.rubric.dimensions.at(-1)!.key,
              nextAction: '再补充一句前后变化的具体内容。',
              strengthEvidence: '作答写出了观察叶片和记录颜色变化。',
            },
            externalTraceId: 'postgres-open-assessment-trace-1',
            inputTokens: 100,
            outputTokens: 180,
            provider: openAssessmentCapability.provider.id,
          };
        },
      },
      qualityControl: {
        authorizeCapability: async ({ slice }) => ({
          ...structuredClone(decision),
          scope: { ...structuredClone(decision.scope), slice: structuredClone(slice) },
        }),
        revalidateAuthorization: async () => ({
          capabilityVersion: openAssessmentCapability,
          containmentEpoch: decision.containmentEpoch,
          decisionId: decision.decisionId,
          status: 'authorized',
        }),
      },
      publicationGate: store,
      store,
    });
    const queued = await service.requestSuggestion({
      actor,
      ageBand: 'middle_primary',
      consentRevision: 1,
      familySpaceId: fixture.familySpaceId,
      inputReference: {
        confirmedContentVersionId: fixture.confirmedContentVersionId,
        processingJobId: fixture.processingJobId,
        questionRegionId: fixture.questionRegionId,
        responseRegionId: fixture.responseRegionId,
      },
      learningProfileId: fixture.learningProfileId,
      materialId: fixture.material.id,
      taskType: 'science_inquiry',
    });
    expect(queued.status).toBe('queued');
    const currentBasis = await fixture.learningContent.getCurrentBasisReference({
      actor,
      learningProfileId: fixture.learningProfileId,
      materialId: fixture.material.id,
    });
    await expect(
      store.resolveOpenAssessmentInput({
        actor,
        ageBand: 'middle_primary',
        basis: currentBasis,
        learningProfileId: fixture.learningProfileId,
        materialId: fixture.material.id,
        reference: {
          confirmedContentVersionId: fixture.confirmedContentVersionId,
          processingJobId: fixture.processingJobId,
          questionRegionId: fixture.questionRegionId,
          responseRegionId: fixture.responseRegionId,
        },
        taskType: 'science_inquiry',
      }),
    ).resolves.not.toBeNull();
    const pending = await service.processSuggestion({
      learningProfileId: fixture.learningProfileId,
      suggestionId: queued.id,
    });

    expect(pending.status).toBe('pending_review');
    const before = await pool.query(
      `SELECT count(*)::integer AS count FROM learning.derived_artifacts
       WHERE artifact_kind = 'assessment' AND artifact_id = $1`,
      [pending.id],
    );
    expect(before.rows[0]?.count).toBe(0);

    const accepted = await service.review({
      decisions: pending.suggestion!.dimensions.map(({ dimensionKey }) => ({
        action: 'accept' as const,
        dimensionKey,
      })),
      expectedStateRevision: pending.stateRevision,
      learningProfileId: fixture.learningProfileId,
      reviewer: { id: randomUUID(), type: 'guardian' },
      suggestionId: pending.id,
    });

    expect(accepted).toMatchObject({
      acceptedResult: { capabilityVersionId: openAssessmentCapability.id },
      status: 'accepted',
    });
    const lineage = await pool.query(
      `SELECT artifact.version, artifact.status, count(edge.*)::integer AS edge_count
       FROM learning.derived_artifacts artifact
       JOIN learning.derivation_edges edge
         ON edge.family_space_id = artifact.family_space_id
        AND edge.learning_profile_id = artifact.learning_profile_id
        AND edge.artifact_kind = artifact.artifact_kind
        AND edge.artifact_id = artifact.artifact_id
        AND edge.artifact_version = artifact.version
       WHERE artifact.artifact_kind = 'assessment' AND artifact.artifact_id = $1
       GROUP BY artifact.version, artifact.status`,
      [pending.id],
    );
    expect(lineage.rows).toEqual([
      { edge_count: 6, status: 'current', version: accepted.acceptedResult!.id },
    ]);
    const persisted = await store.findById(pending.id, fixture.learningProfileId);
    expect(persisted).toMatchObject({
      review: {
        capabilityVersionId: openAssessmentCapability.id,
        rubricVersion: '2.0.0',
      },
      suggestion: pending.suggestion,
    });
    await expect(
      service.getAcceptedResultReference({
        actor,
        learningProfileId: fixture.learningProfileId,
        suggestionId: pending.id,
      }),
    ).resolves.toMatchObject({ assessmentVersionId: accepted.acceptedResult!.id });
    const sourceClient = await pool.connect();
    try {
      await sourceClient.query('BEGIN');
      await sourceClient.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        fixture.familySpaceId,
      ]);
      await sourceClient.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      await syncSourceRevisionInTransaction(sourceClient, {
        occurredAt: '2026-09-10T09:00:00.000Z',
        reason: 'question corrected after accepted suggestion',
        source: {
          familySpaceId: fixture.familySpaceId,
          id: `${fixture.material.id}:${fixture.questionRegionId}`,
          kind: 'question',
          learningProfileId: fixture.learningProfileId,
        },
        version: 'question-corrected-v2',
      });
      await sourceClient.query('COMMIT');
    } catch (error) {
      await sourceClient.query('ROLLBACK');
      throw error;
    } finally {
      sourceClient.release();
    }
    await expect(
      service.getAcceptedResultReference({
        actor,
        learningProfileId: fixture.learningProfileId,
        suggestionId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'DOWNSTREAM_INELIGIBLE' });
  });

  it.each<{
    answerText: string;
    knowledgePointName: string;
    questionText: string;
    rule: ObjectiveGradingRule;
    subject: Subject;
  }>([
    {
      answerText: '42',
      knowledgePointName: '乘法',
      questionText: '6 × 7 = ?',
      rule: { expected: '42', kind: 'numeric' },
      subject: 'mathematics',
    },
    {
      answerText: '快乐',
      knowledgePointName: '近义词',
      questionText: '“高兴”的近义词是什么？',
      rule: {
        acceptedAnswers: ['快乐'],
        caseSensitive: true,
        collapseWhitespace: true,
        kind: 'accepted_text',
      },
      subject: 'chinese',
    },
    {
      answerText: 'CAT',
      knowledgePointName: '单词',
      questionText: '写出英文单词 cat。',
      rule: {
        acceptedAnswers: ['cat'],
        caseSensitive: false,
        collapseWhitespace: true,
        kind: 'accepted_text',
      },
      subject: 'english',
    },
    {
      answerText: 'B',
      knowledgePointName: '物态变化',
      questionText: '水结冰后属于哪种状态？A.气态 B.固态 C.液态',
      rule: { correctOption: 'B', kind: 'single_choice' },
      subject: 'science',
    },
  ])(
    'confirms and applies an immutable $subject production grading rule',
    async ({ answerText, knowledgePointName, questionText, rule, subject }) => {
      if (!pool) return;
      const fixture = await createLearningMaterial({
        answerText,
        knowledgePointName,
        questionText,
        subject,
      });
      const store = new PostgresAssessmentStore(pool);
      const service = new AssessmentService({
        basisReader: fixture.learningContent,
        inputReader: store,
        store,
      });
      const inputReference = {
        confirmedContentVersionId: fixture.confirmedContentVersionId,
        processingJobId: fixture.processingJobId,
        questionRegionId: fixture.questionRegionId,
        responseRegionId: fixture.responseRegionId,
      };
      const confirmed = await service.confirmObjectiveRule({
        actor: { id: randomUUID(), type: 'guardian' },
        familySpaceId: fixture.familySpaceId,
        inputReference,
        learningProfileId: fixture.learningProfileId,
        materialId: fixture.material.id,
        rule,
      });
      const graded = await service.gradeObjective({
        actor: { id: fixture.learningProfileId, type: 'learner' },
        familySpaceId: fixture.familySpaceId,
        inputReference,
        learningProfileId: fixture.learningProfileId,
        materialId: fixture.material.id,
      });

      expect(graded.currentVersion).toMatchObject({
        decision: { outcome: 'correct' },
        gradingRuleVersionId: confirmed.id,
        inputAuthority: { kind: 'confirmed_content' },
        question: { subject },
        rule,
      });
    },
  );

  it('rejects a real answer paired with a different real question', async () => {
    if (!pool) return;
    const fixture = await createLearningMaterial();
    const store = new PostgresAssessmentStore(pool);
    const service = new AssessmentService({
      basisReader: fixture.learningContent,
      inputReader: store,
      store,
    });

    await expect(
      service.gradeObjective({
        actor: { id: fixture.learningProfileId, type: 'learner' },
        familySpaceId: fixture.familySpaceId,
        inputReference: {
          confirmedContentVersionId: fixture.confirmedContentVersionId,
          processingJobId: fixture.processingJobId,
          questionRegionId: 'question-2',
          responseRegionId: fixture.responseRegionId,
        },
        learningProfileId: fixture.learningProfileId,
        materialId: fixture.material.id,
      }),
    ).rejects.toMatchObject({ code: 'TRUSTED_INPUT_NOT_FOUND' });
  });

  it('persists repeated disputes and professional correction provenance', async () => {
    if (!pool) return;
    const fixture = await createLearningMaterial();
    const store = new PostgresAssessmentStore(pool);
    const service = new AssessmentService({
      basisReader: fixture.learningContent,
      inputReader: store,
      store,
    });
    const learner = { id: fixture.learningProfileId, type: 'learner' as const };
    const inputReference = {
      confirmedContentVersionId: fixture.confirmedContentVersionId,
      processingJobId: fixture.processingJobId,
      questionRegionId: fixture.questionRegionId,
      responseRegionId: fixture.responseRegionId,
    };
    const original = await service.gradeObjective({
      actor: learner,
      familySpaceId: fixture.familySpaceId,
      inputReference,
      learningProfileId: fixture.learningProfileId,
      materialId: fixture.material.id,
    });
    const firstDispute = await service.raiseDispute({
      actor: learner,
      assessmentId: original.id,
      correctionText: '我写的是 42。',
      learningProfileId: fixture.learningProfileId,
      reason: '作答识别错误',
      target: 'response',
    });
    const guardianResolved = await service.resolveDispute({
      actor: { id: randomUUID(), type: 'guardian' },
      assessmentId: original.id,
      correction: { responseText: '42' },
      disputeId: firstDispute.openDisputeId!,
      learningProfileId: fixture.learningProfileId,
      reason: '监护人核对原稿后确认',
    });
    const repeated = await service.raiseDispute({
      actor: learner,
      assessmentId: original.id,
      correctionText: '答案依据仍需重新判断。',
      learningProfileId: fixture.learningProfileId,
      reason: '对采用答案仍有疑问',
      target: 'assessment',
    });
    expect(repeated.disputes.at(-1)?.reviewRoute).toBe('professional');
    const reviewerId = randomUUID();
    await service.resolveProfessionalDispute({
      assessmentId: original.id,
      correction: { rule: { expected: '41', kind: 'numeric' } },
      disputeId: repeated.openDisputeId!,
      learningProfileId: fixture.learningProfileId,
      reason: '专业复核确认本题采用答案应为 41',
      reviewCaseId: 'professional-review-case-1',
      reviewer: { id: reviewerId, type: 'professional' },
    });

    await expect(
      service.getAssessment({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toMatchObject({
      currentVersion: {
        createdBy: { id: reviewerId, type: 'professional' },
        inputAuthority: {
          kind: 'professional_review',
          reviewCaseId: 'professional-review-case-1',
          reviewerId,
        },
        predecessorId: guardianResolved.currentVersion.id,
        revision: 3,
      },
      openDisputeId: null,
      resolutions: [
        { resolvedBy: { type: 'guardian' } },
        { resolvedBy: { id: reviewerId, type: 'professional' } },
      ],
    });
  });

  it('atomically persists immutable grading and dispute histories behind profile isolation', async () => {
    if (!pool) return;
    const fixture = await createLearningMaterial();
    const store = new PostgresAssessmentStore(pool);
    const service = new AssessmentService({
      basisReader: fixture.learningContent,
      inputReader: store,
      store,
    });
    const learner = { id: fixture.learningProfileId, type: 'learner' as const };
    const original = await service.gradeObjective({
      actor: learner,
      familySpaceId: fixture.familySpaceId,
      learningProfileId: fixture.learningProfileId,
      materialId: fixture.material.id,
      inputReference: {
        confirmedContentVersionId: fixture.confirmedContentVersionId,
        processingJobId: fixture.processingJobId,
        questionRegionId: fixture.questionRegionId,
        responseRegionId: fixture.responseRegionId,
      },
    });
    const disputed = await service.raiseDispute({
      actor: learner,
      assessmentId: original.id,
      correctionText: '图片中的答案是 42。',
      learningProfileId: fixture.learningProfileId,
      reason: '作答识别错误',
      target: 'response',
    });
    await expect(
      service.getDownstreamReference({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: fixture.learningProfileId,
      }),
    ).rejects.toMatchObject({ code: 'DOWNSTREAM_INELIGIBLE' });
    const resolved = await service.resolveDispute({
      actor: { id: randomUUID(), type: 'guardian' },
      assessmentId: original.id,
      disputeId: disputed.openDisputeId!,
      learningProfileId: fixture.learningProfileId,
      reason: '核对原稿后修正',
    });

    await expect(
      service.getAssessment({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toMatchObject({
      currentVersion: { decision: { outcome: 'incorrect' }, revision: 2 },
      resolutions: [{ resultingAssessmentVersionId: resolved.currentVersion.id }],
      versions: [{ revision: 1 }, { revision: 2 }],
    });
    await expect(
      service.getAssessment({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ASSESSMENT_NOT_FOUND' });

    const trace = await pool.connect();
    try {
      await trace.query('BEGIN');
      await trace.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      const outbox = await trace.query(
        `SELECT event_type, payload
         FROM learning.domain_outbox
         WHERE aggregate_id = $1
         ORDER BY occurred_at, id`,
        [original.id],
      );
      const audit = await trace.query(
        `SELECT action
         FROM learning.assessment_access_audit
         WHERE assessment_id = $1
         ORDER BY occurred_at, id`,
        [original.id],
      );
      const lineage = await trace.query(
        `SELECT artifact.version, artifact.status, count(edge.*)::integer AS edge_count
         FROM learning.derived_artifacts artifact
         JOIN learning.derivation_edges edge
           ON edge.family_space_id = artifact.family_space_id
          AND edge.learning_profile_id = artifact.learning_profile_id
          AND edge.artifact_kind = artifact.artifact_kind
          AND edge.artifact_id = artifact.artifact_id
          AND edge.artifact_version = artifact.version
         WHERE artifact.artifact_kind = 'assessment' AND artifact.artifact_id = $1
         GROUP BY artifact.version, artifact.status, artifact.published_at
         ORDER BY artifact.published_at`,
        [original.id],
      );
      expect(outbox.rows).toHaveLength(3);
      expect(outbox.rows.map(({ event_type }) => event_type)).toEqual(
        expect.arrayContaining([
          'objective_assessment.graded',
          'objective_assessment.disputed',
          'objective_assessment.dispute_resolved',
        ]),
      );
      expect(
        outbox.rows.find(({ event_type }) => event_type === 'objective_assessment.disputed')
          ?.payload,
      ).toMatchObject({
        downstreamEligibility: { eligible: false, reason: 'disputed' },
      });
      expect(
        outbox.rows.find(({ event_type }) => event_type === 'objective_assessment.dispute_resolved')
          ?.payload,
      ).toMatchObject({
        downstreamEligibility: {
          assessmentVersionId: resolved.currentVersion.id,
          eligible: true,
        },
      });
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows.map(({ action }) => action)).toEqual(
        expect.arrayContaining(['assessment.downstream_reference.read', 'assessment.read']),
      );
      expect(lineage.rows).toEqual([
        { edge_count: 5, status: 'superseded', version: original.currentVersion.id },
        { edge_count: 5, status: 'current', version: resolved.currentVersion.id },
      ]);
      await trace.query('COMMIT');
    } catch (error) {
      await trace.query('ROLLBACK');
      throw error;
    } finally {
      trace.release();
    }

    const evidence = await pool.query(
      `SELECT
         has_table_privilege('rhea_assessment_app', 'learning.learning_materials', 'UPDATE') AS can_mutate_material,
         has_table_privilege('rhea_assessment_app', 'learning.learning_materials', 'SELECT') AS can_read_material,
         has_table_privilege(
           'rhea_assessment_app',
           'learning.objective_grading_rule_versions',
           'INSERT'
         ) AS can_insert_rule_directly,
         has_function_privilege(
           'rhea_assessment_app',
           'learning.confirm_objective_grading_rule(uuid,uuid,uuid,uuid,uuid,text,text,uuid,integer,integer,text,text,text,uuid,jsonb,uuid,timestamptz)',
           'EXECUTE'
         ) AS can_confirm_rule,
         has_function_privilege(
           'rhea_assessment_app',
           'learning.lock_current_assessment_basis(uuid,uuid,uuid,integer,integer,text,text,text)',
           'EXECUTE'
         ) AS can_lock_current_basis,
         has_function_privilege(
           'rhea_assessment_app',
           'learning.resolve_confirmed_objective_regions(uuid,uuid,uuid,text,text)',
           'EXECUTE'
         ) AS can_resolve_regions_directly,
         has_function_privilege(
           'rhea_assessment_app',
           'learning.resolve_objective_assessment_basis(uuid,uuid,uuid,uuid,integer,integer)',
           'EXECUTE'
         ) AS can_resolve_basis_directly,
         has_table_privilege(
           'rhea_assessment_app',
           'learning.suggested_assessments',
           'INSERT'
         ) AS can_insert_suggestion_directly,
         has_function_privilege(
           'rhea_assessment_app',
           'learning.create_suggested_assessment(jsonb)',
           'EXECUTE'
         ) AS can_create_pending_suggestion,
         has_function_privilege(
           'rhea_assessment_app',
           'learning.review_suggested_assessment(uuid,uuid,integer,text,jsonb,jsonb,timestamp with time zone)',
           'EXECUTE'
         ) AS can_review_suggestion,
         has_schema_privilege('rhea_assessment_app', 'safety', 'USAGE') AS can_use_safety`,
    );
    expect(evidence.rows[0]).toEqual({
      can_confirm_rule: true,
      can_create_pending_suggestion: true,
      can_insert_suggestion_directly: false,
      can_insert_rule_directly: false,
      can_lock_current_basis: true,
      can_mutate_material: false,
      can_read_material: false,
      can_resolve_basis_directly: false,
      can_resolve_regions_directly: false,
      can_review_suggestion: true,
      can_use_safety: false,
    });
  });
});
