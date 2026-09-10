import { createHash, randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import {
  generatedLearningSourceKey,
  type GeneratedLearningContentVersion,
  type GenerationSourceSnapshot,
  type ModelRunRecord,
  type StoredGenerationRequest,
} from '@rhea/generated-learning';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresQualityControlStore } from '../../postgres-quality-control/src/index.js';
import {
  QualityControlService,
  type AuthorizationDecision,
  type CapabilityUseSlice,
  type CapabilityVersion,
  type EvaluationSlice,
  type RequiredSlicePolicy,
} from '../../../modules/quality-control/src/index.js';
import { PostgresGeneratedLearningStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

const generatedLearningUseSlice = {
  basisState: 'current',
  gradeBand: 'middle_primary',
  imageQuality: 'not_applicable',
  questionType: 'process',
  riskLevel: 'medium',
  subject: 'mathematics',
} satisfies CapabilityUseSlice;

const recognitionUseSlice = {
  basisState: 'not_applicable',
  gradeBand: 'unclassified',
  imageQuality: 'clear',
  questionType: 'unclassified',
  riskLevel: 'unclassified',
  subject: 'unclassified',
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
let releasedCapability: CapabilityVersion | undefined;
let releasedRecognitionCapability: CapabilityVersion | undefined;
const noSignedCapabilityFamilySpaceId = randomUUID();
let noSignedCapabilityDecision: AuthorizationDecision | undefined;

async function registerReleasedCapability(
  service: QualityControlService,
  options: {
    capabilityKey: string;
    kind: CapabilityVersion['kind'];
    unqualifiedFamilySpaceId?: string;
    useSlice: CapabilityUseSlice;
  },
): Promise<{ unqualifiedDecision: AuthorizationDecision | null; version: CapabilityVersion }> {
  const suffix = randomUUID();
  const policy: RequiredSlicePolicy = {
    minimumSampleSize: 20,
    registeredAt: '2026-09-10T07:00:00.000Z',
    requiredSignoffRoles: ['quality_owner', 'domain_reviewer', 'child_safety'],
    requiredSlices: requiredEvaluationSlices,
    version: `generated-learning-quality-policy-${suffix}`,
  };
  const version: CapabilityVersion = {
    adapter: {
      id: options.kind === 'ai' ? 'fixed-adapter' : 'fixed-recognition-adapter',
      version: options.kind === 'ai' ? 'fixed-adapter-v1' : 'fixed-recognition-v1',
    },
    artifactHash: 'f'.repeat(64),
    capabilityKey: options.capabilityKey,
    id: `${options.kind}-capability-${suffix}`,
    implementedBy: `test-engineer-${suffix}`,
    kind: options.kind,
    modelOrEngine: {
      id: options.kind === 'ai' ? 'fixed-model' : 'fixed-ocr-engine',
      version: options.kind === 'ai' ? 'fixed-model-v1' : 'fixed-ocr-engine-v1',
    },
    policyVersion: 'child-learning-policy-v1',
    promptOrConfig: {
      kind: options.kind === 'ai' ? 'prompt' : 'config',
      version: options.kind === 'ai' ? 'lesson-support-prompt-v1' : 'recognition-config-v1',
    },
    provider: {
      id: options.kind === 'ai' ? 'fixed-test-model' : 'fixed-test-recognition',
      version: 'fixed-provider-contract-v1',
    },
    region: 'test-local',
    registeredAt: '2026-09-10T07:00:01.000Z',
    requiredSlicePolicyVersion: policy.version,
    templateVersion: 'lesson-support-template-v1',
  };

  await service.registerSlicePolicy({ commandId: `register-policy-${suffix}`, policy });
  let record = await service.registerCapability({
    commandId: `register-capability-${suffix}`,
    version,
  });
  const unqualifiedDecision = options.unqualifiedFamilySpaceId
    ? await service.authorizeCapability({
        capabilityKey: version.capabilityKey,
        familySpaceId: options.unqualifiedFamilySpaceId,
        kind: version.kind,
        slice: options.useSlice,
      })
    : null;
  for (const [index, slice] of requiredEvaluationSlices.entries()) {
    record = await service.recordEvaluation({
      commandId: `record-evaluation-${suffix}-${index}`,
      expectedRevision: record.revision,
      run: {
        capabilityVersionId: version.id,
        completedAt: `2026-09-10T07:01:0${index}.000Z`,
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
      signedAt: `2026-09-10T07:02:0${index}.000Z`,
      signer: { id: `${role}-${suffix}`, role },
    });
    record = await service.getCapability(qualification.capabilityVersionId);
  }
  for (const rollout of [
    { changedAt: '2026-09-10T07:03:00.000Z', percentage: 0, stage: 'shadow' as const },
    { changedAt: '2026-09-10T07:04:00.000Z', percentage: 10, stage: 'small' as const },
    { changedAt: '2026-09-10T07:05:00.000Z', percentage: 50, stage: 'expanded' as const },
    { changedAt: '2026-09-10T07:06:00.000Z', percentage: 100, stage: 'general' as const },
  ]) {
    record = await service.advanceRollout({
      allowedUseSlices: [options.useSlice],
      capabilityVersionId: version.id,
      commandId: `rollout-${suffix}-${rollout.stage}`,
      expectedRevision: record.revision,
      ...rollout,
    });
  }
  return { unqualifiedDecision, version };
}

beforeAll(async () => {
  if (!pool) return;
  await applyMigrations(pool, await loadDefaultMigrations());
  qualityControl = new QualityControlService(new PostgresQualityControlStore(pool));
  const generatedLearningRelease = await registerReleasedCapability(qualityControl, {
    capabilityKey: 'ai.generated-learning',
    kind: 'ai',
    unqualifiedFamilySpaceId: noSignedCapabilityFamilySpaceId,
    useSlice: generatedLearningUseSlice,
  });
  releasedCapability = generatedLearningRelease.version;
  noSignedCapabilityDecision = generatedLearningRelease.unqualifiedDecision ?? undefined;
  releasedRecognitionCapability = (
    await registerReleasedCapability(qualityControl, {
      capabilityKey: 'submission.recognition',
      kind: 'ocr',
      useSlice: recognitionUseSlice,
    })
  ).version;
});

afterAll(async () => pool?.end());

interface Fixture {
  classificationId: string;
  familySpaceId: string;
  learningProfileId: string;
  materialId: string;
  processingJobId: string;
  request: StoredGenerationRequest;
  source: GenerationSourceSnapshot;
}

async function createFixture(familySpaceId = randomUUID()): Promise<Fixture> {
  if (!pool) throw new Error('Database is not configured');
  const qualityAuthority = qualityControl;
  const generatedLearningCapability = releasedCapability;
  const recognitionCapability = releasedRecognitionCapability;
  if (!qualityAuthority || !generatedLearningCapability || !recognitionCapability) {
    throw new Error('Quality-control fixture is not initialized');
  }
  const guardianId = randomUUID();
  const learningProfileId = randomUUID();
  const uploadSessionId = randomUUID();
  const processingJobId = randomUUID();
  const candidateId = randomUUID();
  const confirmedContentVersionId = randomUUID();
  const materialId = randomUUID();
  const classificationId = randomUUID();
  const coursePathId = randomUUID();
  const unitId = randomUUID();
  const knowledgePointId = randomUUID();
  const initialSourceVersionId = randomUUID();
  const sourceVersionId = randomUUID();
  const initialSelectionId = randomUUID();
  const sourceHash = 'a'.repeat(64);
  const basisHash = 'b'.repeat(64);
  const questionText = '36 ÷ 4 = ?';
  const answerText = '9';
  const recognitionDecision = await qualityAuthority.authorizeCapability({
    capabilityKey: recognitionCapability.capabilityKey,
    familySpaceId,
    kind: recognitionCapability.kind,
    slice: recognitionUseSlice,
  });
  if (
    recognitionDecision.status !== 'authorized' ||
    recognitionDecision.primary?.capabilityVersion.id !== recognitionCapability.id
  ) {
    throw new Error('Signed recognition capability was not authorized');
  }
  const regions = [
    {
      confidence: 0.99,
      id: 'question-1',
      kind: 'question',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      questionRegionId: null,
      readingOrder: 0,
      text: questionText,
    },
    {
      confidence: 0.99,
      id: 'answer-1',
      kind: 'answer',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      questionRegionId: 'question-1',
      readingOrder: 1,
      text: answerText,
    },
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rhea.identity_subject', $1, true)`, [
      `test:${guardianId}`,
    ]);
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
    await client.query(`SELECT set_config('rhea.guardian_id', $1, true)`, [guardianId]);
    await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
      learningProfileId,
    ]);
    await client.query(`INSERT INTO learning.guardians (id, identity_subject) VALUES ($1, $2)`, [
      guardianId,
      `test:${guardianId}`,
    ]);
    await client.query(`INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)`, [
      familySpaceId,
      '生成学习内容测试家庭',
    ]);
    await client.query(
      `INSERT INTO learning.guardian_memberships
        (family_space_id, guardian_id, role, status)
       VALUES ($1, $2, 'managing', 'active')`,
      [familySpaceId, guardianId],
    );
    await client.query(
      `INSERT INTO learning.learning_profiles
        (id, family_space_id, display_name, grade, pin_hash)
       VALUES ($1, $2, '小禾', 3, 'test-hash')`,
      [learningProfileId, familySpaceId],
    );
    await client.query(
      `INSERT INTO learning.family_consents
        (family_space_id, kind, status, statement_version, revision,
         updated_by_guardian_id, updated_at)
       VALUES ($1, 'ai_processing', 'granted', 'ai-v1', 1, $2, now())`,
      [familySpaceId, guardianId],
    );
    await client.query(
      `INSERT INTO learning.upload_sessions
        (id, family_space_id, learning_profile_id, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'submitted', now(), now() + interval '1 hour')`,
      [uploadSessionId, familySpaceId, learningProfileId],
    );
    await client.query(
      `INSERT INTO learning.processing_jobs
        (id, upload_session_id, family_space_id, learning_profile_id, status,
         quality_issues, cancellation_version, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'completed', '[]', 0, 1, now(), now())`,
      [processingJobId, uploadSessionId, familySpaceId, learningProfileId],
    );
    await client.query(
      `INSERT INTO learning.recognition_candidates
        (id, job_id, family_space_id, learning_profile_id, adapter_version,
         source_hash, regions, finished_at, capability_key, capability_kind,
         capability_version_id, authorization_decision_id,
         authorization_containment_epoch, authorization_family_space_hash,
         capability_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12,
               $13, $14, $15::jsonb)`,
      [
        candidateId,
        processingJobId,
        familySpaceId,
        learningProfileId,
        recognitionCapability.adapter.version,
        sourceHash,
        JSON.stringify(regions),
        '2026-09-10T07:30:00.000Z',
        recognitionCapability.capabilityKey,
        recognitionCapability.kind,
        recognitionCapability.id,
        recognitionDecision.decisionId,
        recognitionDecision.containmentEpoch,
        createHash('sha256').update(familySpaceId).digest('hex'),
        JSON.stringify(recognitionCapability),
      ],
    );
    await client.query(
      `INSERT INTO learning.confirmed_content_versions
        (id, job_id, learning_profile_id, version, source_candidate_id, source_hash,
         regions, confirmed_by_learning_profile_id, confirmed_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $3, now())`,
      [
        confirmedContentVersionId,
        processingJobId,
        learningProfileId,
        candidateId,
        sourceHash,
        JSON.stringify(regions),
      ],
    );
    await client.query(
      `INSERT INTO learning.course_paths
        (id, family_space_id, learning_profile_id, subject, name)
       VALUES ($1, $2, $3, 'mathematics', '三年级上册')`,
      [coursePathId, familySpaceId, learningProfileId],
    );
    await client.query(
      `INSERT INTO learning.learning_units
        (id, family_space_id, learning_profile_id, subject, course_path_id, name)
       VALUES ($1, $2, $3, 'mathematics', $4, '除法')`,
      [unitId, familySpaceId, learningProfileId, coursePathId],
    );
    await client.query(
      `INSERT INTO learning.knowledge_points
        (id, family_space_id, learning_profile_id, subject, name)
       VALUES ($1, $2, $3, 'mathematics', '两位数除以一位数')`,
      [knowledgePointId, familySpaceId, learningProfileId],
    );
    await client.query(
      `INSERT INTO learning.learning_materials
        (id, family_space_id, learning_profile_id, confirmed_content_version_id,
         source_hash, validity_epoch, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, now())`,
      [materialId, familySpaceId, learningProfileId, confirmedContentVersionId, sourceHash],
    );
    await client.query(
      `INSERT INTO learning.classification_versions
        (id, material_id, family_space_id, learning_profile_id, revision, status,
         primary_subject, related_subjects, course_path_id, unit_id, source,
         changed_by_type, changed_by_id, changed_at)
       VALUES ($1, $2, $3, $4, 1, 'classified', 'mathematics', '{}', $5, $6,
               'initial', 'learner', $4, now())`,
      [classificationId, materialId, familySpaceId, learningProfileId, coursePathId, unitId],
    );
    await client.query(
      `INSERT INTO learning.classification_knowledge_points
        (classification_version_id, knowledge_point_id, learning_profile_id,
         is_primary, position)
       VALUES ($1, $2, $3, true, 0)`,
      [classificationId, knowledgePointId, learningProfileId],
    );
    await client.query(
      `INSERT INTO learning.learning_source_versions
        (id, material_id, family_space_id, learning_profile_id, kind, version_number,
         label, source_key, version_label, content_hash, conflicts_with_source_version_ids,
         source_confirmed_content_version_id, created_by_type, created_by_id, created_at)
       VALUES
         ($1, $3, $4, $5, 'learning_material', 1, '已确认学习资料',
          $6, 'confirmed-content-v1', $7, '{}', $8, 'learner', $5, now()),
         ($2, $3, $4, $5, 'answer', 1, '教师答案',
          'teacher-answer:question-1', '教师答案第 1 版', $9, '{}', NULL,
          'learner', $5, now())`,
      [
        initialSourceVersionId,
        sourceVersionId,
        materialId,
        familySpaceId,
        learningProfileId,
        `confirmed-content:${confirmedContentVersionId}`,
        sourceHash,
        confirmedContentVersionId,
        basisHash,
      ],
    );
    await client.query(
      `INSERT INTO learning.basis_selection_versions
        (id, material_id, family_space_id, learning_profile_id, version,
         source_version_id, reason, selected_by_type, selected_by_id, selected_at)
       VALUES ($1, $2, $3, $4, 1, $5, '首次确认的学习资料', 'learner', $4, now())`,
      [initialSelectionId, materialId, familySpaceId, learningProfileId, initialSourceVersionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const source: GenerationSourceSnapshot = {
    ageBand: 'middle_primary',
    basis: {
      contentHash: sourceHash,
      kind: 'learning_material',
      materialId,
      selectionVersion: 1,
      sourceVersionId: initialSourceVersionId,
      validityEpoch: 1,
      versionLabel: 'confirmed-content-v1',
    },
    basisHasConflict: false,
    classificationRevision: 1,
    confirmedContentVersionId,
    coursePathName: '三年级上册',
    excerpts: [
      { kind: 'question', regionId: 'question-1', text: questionText },
      { kind: 'answer', regionId: 'answer-1', text: answerText },
    ],
    knowledgePointNames: ['两位数除以一位数'],
    processingJobId,
    subject: 'mathematics',
    unitName: '除法',
  };
  const createdAt = '2026-09-10T08:00:00.000Z';
  const decision = await qualityAuthority.authorizeCapability({
    capabilityKey: generatedLearningCapability.capabilityKey,
    familySpaceId,
    kind: generatedLearningCapability.kind,
    slice: generatedLearningUseSlice,
  });
  if (
    decision.status !== 'authorized' ||
    decision.primary?.capabilityVersion.id !== generatedLearningCapability.id
  ) {
    throw new Error('Signed generated-learning capability was not authorized');
  }
  const capability = decision.primary.capabilityVersion;
  const request: StoredGenerationRequest = {
    actor: { id: learningProfileId, type: 'learner' },
    authorization: {
      containmentEpoch: decision.containmentEpoch,
      degradedReason: decision.degradedReason,
      decisionId: decision.decisionId,
      issuedAt: decision.issuedAt,
    },
    capability,
    consentRevision: 1,
    createdAt,
    currentVersionId: null,
    familySpaceId,
    id: randomUUID(),
    idempotencyKey: `request-${randomUUID()}`,
    latestChecks: [],
    learningProfileId,
    materialId,
    modelRuns: [],
    processingLeaseExpiresAt: null,
    purpose: 'learning_pack',
    requestFingerprint: 'f'.repeat(64),
    revealedHintLevel: 0,
    source,
    stateRevision: 0,
    status: 'queued',
    unavailableReason: null,
    updatedAt: createdAt,
    versions: [],
  };
  return {
    classificationId,
    familySpaceId,
    learningProfileId,
    materialId,
    processingJobId,
    request,
    source,
  };
}

function versionFor(request: StoredGenerationRequest): GeneratedLearningContentVersion {
  if (!request.capability) throw new Error('fixture requires an approved capability');
  return {
    authorization: structuredClone(request.authorization),
    capability: structuredClone(request.capability),
    checks: [
      { detail: '适合年龄层级', kind: 'age_appropriateness', passed: true },
      { detail: '提示未泄露答案', kind: 'answer_leakage', passed: true },
      { detail: '答案与规则一致', kind: 'consistency', passed: true },
      { detail: '内容安全', kind: 'safety', passed: true },
      { detail: '结构完整', kind: 'schema', passed: true },
      { detail: '题目可解', kind: 'solvability', passed: true },
      { detail: '来源覆盖完整', kind: 'source_coverage', passed: true },
    ],
    contentState: 'direct_learning',
    createdAt: '2026-09-10T08:01:00.000Z',
    id: randomUUID(),
    pack: {
      fullExplanation: { answer: '9', steps: ['36 里面有 9 个 4。'] },
      keyTerms: [{ sourceRegionIds: ['question-1'], term: '除法' }],
      methodHint: '想一想 4 乘几等于 36。',
      orientationHint: '先找总数和每组数量。',
      quiz: [
        {
          explanationSteps: ['24 里面有 6 个 4。'],
          expectedAnswer: '6',
          gradingRule: { expected: '6', kind: 'numeric' },
          id: 'quiz-1',
          question: '24 ÷ 4 = ?',
        },
      ],
      summary: { keyPoints: ['可以用乘法口诀想除法。'], title: '用乘法想除法' },
      supplementalNotes: [],
      variations: [
        {
          explanationSteps: ['32 里面有 8 个 4。'],
          expectedAnswer: '8',
          gradingRule: { expected: '8', kind: 'numeric' },
          id: 'variation-1',
          question: '32 ÷ 4 = ?',
        },
      ],
    },
    predecessorId: null,
    revision: 1,
    source: structuredClone(request.source),
  };
}

function successfulModelRunFor(
  request: StoredGenerationRequest,
  finishedAt: string,
  externalTraceId: string,
): ModelRunRecord {
  if (!request.capability) throw new Error('fixture requires an approved capability');
  return {
    attempt: 1,
    authorizationDecisionId: request.authorization.decisionId,
    capabilityVersionId: request.capability.id,
    externalTraceId,
    finishedAt,
    inputTokens: 100,
    modelOrEngineVersion: request.capability.modelOrEngine.version,
    observedProvider: request.capability.provider.id,
    outputTokens: 200,
    promptOrConfigVersion: request.capability.promptOrConfig.version,
    provider: request.capability.provider.id,
    providerVersion: request.capability.provider.version,
    succeeded: true,
  };
}

async function mutateFixture(fixture: Fixture, sql: string, values: unknown[] = []): Promise<void> {
  if (!pool) throw new Error('Database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
      fixture.familySpaceId,
    ]);
    await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
      fixture.learningProfileId,
    ]);
    await client.query(sql, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createAsGeneratedLearningRole(
  request: StoredGenerationRequest,
  sourceKey: string,
): Promise<boolean> {
  if (!pool) throw new Error('Database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_generated_learning_app');
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
      request.familySpaceId,
    ]);
    await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
      request.learningProfileId,
    ]);
    const result = await client.query<{ created: boolean }>(
      `SELECT learning.create_generated_learning_request(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19,
         $20, $21::jsonb, $22::jsonb, $23, $24
       ) AS created`,
      [
        request.id,
        request.familySpaceId,
        request.learningProfileId,
        request.materialId,
        request.idempotencyKey,
        request.requestFingerprint,
        request.purpose,
        request.actor.type,
        request.actor.id,
        request.consentRevision,
        JSON.stringify(request.authorization),
        request.capability ? JSON.stringify(request.capability) : null,
        JSON.stringify(request.source),
        sourceKey,
        request.status,
        request.unavailableReason,
        request.currentVersionId,
        request.revealedHintLevel,
        request.processingLeaseExpiresAt,
        request.stateRevision,
        JSON.stringify(request.latestChecks),
        JSON.stringify(request.modelRuns),
        request.createdAt,
        request.updatedAt,
      ],
    );
    await client.query('COMMIT');
    return result.rows[0]?.created === true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expectAtomicCompletionRefusal(
  fixture: Fixture,
  mutate: () => Promise<void>,
  expected: 'consent_withdrawn' | 'source_changed',
): Promise<void> {
  if (!pool) throw new Error('Database is not configured');
  const store = new PostgresGeneratedLearningStore(pool);
  await store.create(fixture.request);
  await store.markGenerating({
    expectedStateRevision: 0,
    leaseExpiresAt: '2026-09-10T08:02:00.000Z',
    learningProfileId: fixture.learningProfileId,
    now: '2026-09-10T08:00:00.000Z',
    requestId: fixture.request.id,
    updatedAt: '2026-09-10T08:00:00.000Z',
  });
  await mutate();
  const version = versionFor(fixture.request);
  await expect(
    store.complete({
      expectedStateRevision: 1,
      latestChecks: version.checks,
      learningProfileId: fixture.learningProfileId,
      modelRuns: [successfulModelRunFor(fixture.request, version.createdAt, 'fixture-trace')],
      requestId: fixture.request.id,
      version,
    }),
  ).resolves.toBe(expected);
  await expect(
    store.findById(fixture.request.id, fixture.learningProfileId),
  ).resolves.toMatchObject({
    currentVersionId: null,
    status: 'generating',
    versions: [],
  });

  const evidence = await pool.connect();
  try {
    await evidence.query('BEGIN');
    await evidence.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
      fixture.learningProfileId,
    ]);
    const published = await evidence.query(
      `SELECT 1 FROM learning.domain_outbox
       WHERE aggregate_id = $1 AND event_type = 'generated_learning.published'`,
      [fixture.request.id],
    );
    expect(published.rows).toHaveLength(0);
    await evidence.query('COMMIT');
  } catch (error) {
    await evidence.query('ROLLBACK');
    throw error;
  } finally {
    evidence.release();
  }
}

async function publishFixture(
  fixture: Fixture,
  store: PostgresGeneratedLearningStore,
): Promise<GeneratedLearningContentVersion> {
  await store.create(fixture.request);
  await store.markGenerating({
    expectedStateRevision: 0,
    leaseExpiresAt: '2026-09-10T08:02:00.000Z',
    learningProfileId: fixture.learningProfileId,
    now: '2026-09-10T08:00:00.000Z',
    requestId: fixture.request.id,
    updatedAt: '2026-09-10T08:00:00.000Z',
  });
  const version = versionFor(fixture.request);
  await expect(
    store.complete({
      expectedStateRevision: 1,
      latestChecks: version.checks,
      learningProfileId: fixture.learningProfileId,
      modelRuns: [successfulModelRunFor(fixture.request, version.createdAt, 'published-fixture')],
      requestId: fixture.request.id,
      version,
    }),
  ).resolves.toBe('completed');
  return version;
}

describeWithDatabase('PostgreSQL generated learning adapter', () => {
  it('persists a checked immutable generation and its source lineage atomically', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);

    await expect(
      store.authorize({
        ageBand: fixture.source.ageBand,
        consentRevision: fixture.request.consentRevision,
        familySpaceId: fixture.familySpaceId,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.authorize({
        ageBand: 'lower_primary',
        consentRevision: fixture.request.consentRevision,
        familySpaceId: fixture.familySpaceId,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(false);

    expect(await store.create(fixture.request)).toBe(true);
    expect(await store.create(fixture.request)).toBe(false);
    expect(
      await store.markGenerating({
        expectedStateRevision: 0,
        leaseExpiresAt: '2026-09-10T08:02:00.000Z',
        learningProfileId: fixture.learningProfileId,
        now: '2026-09-10T08:00:00.000Z',
        requestId: fixture.request.id,
        updatedAt: '2026-09-10T08:00:00.000Z',
      }),
    ).toBe(true);
    const version = versionFor(fixture.request);
    expect(
      await store.complete({
        expectedStateRevision: 1,
        latestChecks: version.checks,
        learningProfileId: fixture.learningProfileId,
        modelRuns: [
          {
            attempt: 1,
            authorizationDecisionId: fixture.request.authorization.decisionId,
            capabilityVersionId: fixture.request.capability!.id,
            externalTraceId: 'trace-1',
            finishedAt: version.createdAt,
            inputTokens: 100,
            modelOrEngineVersion: fixture.request.capability!.modelOrEngine.version,
            observedProvider: fixture.request.capability!.provider.id,
            outputTokens: 200,
            promptOrConfigVersion: fixture.request.capability!.promptOrConfig.version,
            provider: fixture.request.capability!.provider.id,
            providerVersion: fixture.request.capability!.provider.version,
            succeeded: true,
          },
        ],
        requestId: fixture.request.id,
        version,
      }),
    ).toBe('completed');

    await expect(
      store.findById(fixture.request.id, fixture.learningProfileId),
    ).resolves.toMatchObject({
      authorization: fixture.request.authorization,
      capability: fixture.request.capability,
      currentVersionId: version.id,
      latestChecks: version.checks,
      modelRuns: [
        {
          authorizationDecisionId: fixture.request.authorization.decisionId,
          capabilityVersionId: fixture.request.capability!.id,
          externalTraceId: 'trace-1',
          modelOrEngineVersion: fixture.request.capability!.modelOrEngine.version,
          observedProvider: fixture.request.capability!.provider.id,
          promptOrConfigVersion: fixture.request.capability!.promptOrConfig.version,
          provider: fixture.request.capability!.provider.id,
          providerVersion: fixture.request.capability!.provider.version,
          succeeded: true,
        },
      ],
      status: 'ready',
      versions: [
        {
          authorization: fixture.request.authorization,
          capability: fixture.request.capability,
          id: version.id,
          pack: version.pack,
          source: fixture.source,
        },
      ],
    });
    await expect(
      store.findLatestReadyForSource(
        generatedLearningSourceKey(fixture.source),
        fixture.learningProfileId,
      ),
    ).resolves.toMatchObject({ id: fixture.request.id });

    const evidence = await pool.connect();
    try {
      await evidence.query('BEGIN');
      await evidence.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      const [events, edges, lineage, sharedLineage] = await Promise.all([
        evidence.query(
          `SELECT event_type, payload FROM learning.domain_outbox
           WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
          [fixture.request.id],
        ),
        evidence.query(
          `SELECT source_type, source_id, usage
           FROM learning.generated_learning_source_edges
           WHERE generated_version_id = $1 ORDER BY position`,
          [version.id],
        ),
        evidence.query(
          `SELECT
             request.authorization_snapshot AS request_authorization,
             request.authorization_decision_id AS request_decision_id,
             request.authorization_containment_epoch AS request_containment_epoch,
             request.capability_version_id AS request_capability_version_id,
             version.authorization_snapshot AS version_authorization,
             version.authorization_decision_id AS version_decision_id,
             version.authorization_containment_epoch AS version_containment_epoch,
             version.capability_version_id AS version_capability_version_id
           FROM learning.generated_learning_requests AS request
           JOIN learning.generated_learning_content_versions AS version
             ON version.request_id = request.id
           WHERE request.id = $1 AND version.id = $2`,
          [fixture.request.id, version.id],
        ),
        evidence.query(
          `SELECT artifact.artifact_kind, artifact.status, count(edge.*)::integer AS edge_count
           FROM learning.derived_artifacts artifact
           JOIN learning.derivation_edges edge
             ON edge.family_space_id = artifact.family_space_id
            AND edge.learning_profile_id = artifact.learning_profile_id
            AND edge.artifact_kind = artifact.artifact_kind
            AND edge.artifact_id = artifact.artifact_id
            AND edge.artifact_version = artifact.version
           WHERE artifact.artifact_id = $1 AND artifact.version = $2
           GROUP BY artifact.artifact_kind, artifact.status
           ORDER BY artifact.artifact_kind`,
          [fixture.request.id, version.id],
        ),
      ]);
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        'generated_learning.requested',
        'generated_learning.published',
      ]);
      expect(events.rows.map(({ payload }) => payload)).toEqual([
        expect.objectContaining({
          authorizationDecisionId: fixture.request.authorization.decisionId,
          capabilityVersionId: fixture.request.capability!.id,
          status: 'queued',
        }),
        expect.objectContaining({
          authorizationDecisionId: fixture.request.authorization.decisionId,
          capabilityVersionId: fixture.request.capability!.id,
          generatedContentVersionId: version.id,
        }),
      ]);
      expect(lineage.rows).toEqual([
        {
          request_authorization: fixture.request.authorization,
          request_capability_version_id: fixture.request.capability!.id,
          request_containment_epoch: fixture.request.authorization.containmentEpoch.toString(),
          request_decision_id: fixture.request.authorization.decisionId,
          version_authorization: fixture.request.authorization,
          version_capability_version_id: fixture.request.capability!.id,
          version_containment_epoch: fixture.request.authorization.containmentEpoch.toString(),
          version_decision_id: fixture.request.authorization.decisionId,
        },
      ]);
      expect(edges.rows).toEqual([
        {
          source_id: fixture.source.basis.sourceVersionId,
          source_type: 'learning_basis',
          usage: 'current_basis',
        },
        {
          source_id: fixture.source.confirmedContentVersionId,
          source_type: 'confirmed_content',
          usage: 'model_input',
        },
        { source_id: 'question-1', source_type: 'question', usage: 'model_input' },
        { source_id: 'answer-1', source_type: 'answer', usage: 'model_input' },
      ]);
      expect(sharedLineage.rows).toEqual([
        { artifact_kind: 'explanation', edge_count: 3, status: 'current' },
        { artifact_kind: 'generated_learning', edge_count: 3, status: 'current' },
      ]);
      await evidence.query('COMMIT');
    } catch (error) {
      await evidence.query('ROLLBACK');
      throw error;
    } finally {
      evidence.release();
    }
  });

  it('refuses publication unless every required generation check passes exactly once', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);
    await store.create(fixture.request);
    await store.markGenerating({
      expectedStateRevision: 0,
      leaseExpiresAt: '2026-09-10T08:02:00.000Z',
      learningProfileId: fixture.learningProfileId,
      now: '2026-09-10T08:00:00.000Z',
      requestId: fixture.request.id,
      updatedAt: '2026-09-10T08:00:00.000Z',
    });
    const completeVersion = versionFor(fixture.request);
    const version = {
      ...completeVersion,
      checks: completeVersion.checks.filter(({ kind }) =>
        ['schema', 'source_coverage'].includes(kind),
      ),
    };

    await expect(
      store.complete({
        expectedStateRevision: 1,
        latestChecks: version.checks,
        learningProfileId: fixture.learningProfileId,
        modelRuns: [
          successfulModelRunFor(fixture.request, version.createdAt, 'incomplete-checks-result'),
        ],
        requestId: fixture.request.id,
        version,
      }),
    ).resolves.toBe('conflict');

    const bypass = await pool.connect();
    try {
      await bypass.query('BEGIN');
      await bypass.query('SET LOCAL ROLE rhea_generated_learning_app');
      await bypass.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        fixture.familySpaceId,
      ]);
      await bypass.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      const direct = await bypass.query<{ result: string }>(
        `SELECT learning.complete_generated_learning_request(
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
           $12::jsonb, $13::jsonb, $14::jsonb, $15
         ) AS result`,
        [
          fixture.request.id,
          fixture.learningProfileId,
          1,
          version.id,
          version.predecessorId,
          version.revision,
          version.contentState,
          JSON.stringify(version.authorization),
          JSON.stringify(version.capability),
          JSON.stringify(version.source),
          JSON.stringify(version.pack),
          JSON.stringify(version.checks),
          JSON.stringify(version.checks),
          JSON.stringify([]),
          version.createdAt,
        ],
      );
      expect(direct.rows[0]?.result).toBe('conflict');
      await bypass.query('COMMIT');
    } catch (error) {
      await bypass.query('ROLLBACK');
      throw error;
    } finally {
      bypass.release();
    }
    await expect(
      store.findById(fixture.request.id, fixture.learningProfileId),
    ).resolves.toMatchObject({
      currentVersionId: null,
      status: 'generating',
      versions: [],
    });

    const rogueSuccess = await createFixture();
    await store.create(rogueSuccess.request);
    await store.markGenerating({
      expectedStateRevision: 0,
      leaseExpiresAt: '2026-09-10T08:02:00.000Z',
      learningProfileId: rogueSuccess.learningProfileId,
      now: '2026-09-10T08:00:00.000Z',
      requestId: rogueSuccess.request.id,
      updatedAt: '2026-09-10T08:00:00.000Z',
    });
    const rogueVersion = versionFor(rogueSuccess.request);
    const forgedSuccessfulRun = {
      ...successfulModelRunFor(rogueSuccess.request, rogueVersion.createdAt, 'rogue-success'),
      observedProvider: 'unapproved-provider',
    };
    await expect(
      store.complete({
        expectedStateRevision: 1,
        latestChecks: rogueVersion.checks,
        learningProfileId: rogueSuccess.learningProfileId,
        modelRuns: [forgedSuccessfulRun],
        requestId: rogueSuccess.request.id,
        version: rogueVersion,
      }),
    ).resolves.toBe('conflict');
    await expect(
      store.findById(rogueSuccess.request.id, rogueSuccess.learningProfileId),
    ).resolves.toMatchObject({ currentVersionId: null, modelRuns: [], versions: [] });
  });

  it('rejects forged material and source-key identities at create and complete boundaries', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);
    const mismatchedMaterial: StoredGenerationRequest = {
      ...structuredClone(fixture.request),
      id: randomUUID(),
      idempotencyKey: `request-${randomUUID()}`,
      source: {
        ...structuredClone(fixture.source),
        basis: { ...structuredClone(fixture.source.basis), materialId: randomUUID() },
      },
    };
    await expect(store.create(mismatchedMaterial)).resolves.toBe(false);
    await expect(createAsGeneratedLearningRole(fixture.request, 'forged-source-key')).resolves.toBe(
      false,
    );

    const forged: StoredGenerationRequest = {
      ...structuredClone(fixture.request),
      id: randomUUID(),
      idempotencyKey: `request-${randomUUID()}`,
    };
    await mutateFixture(
      fixture,
      `INSERT INTO learning.generated_learning_requests
        (id, family_space_id, learning_profile_id, material_id, idempotency_key,
         request_fingerprint, purpose, actor_type, actor_id, consent_revision,
         capability, source_snapshot, source_key, status, unavailable_reason,
         current_version_id, revealed_hint_level, processing_lease_expires_at,
         state_revision, latest_checks, model_runs, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::jsonb, 'forged-source-key', 'queued', NULL,
               NULL, 0, NULL, 0, '[]'::jsonb, '[]'::jsonb, $13, $13)`,
      [
        forged.id,
        forged.familySpaceId,
        forged.learningProfileId,
        forged.materialId,
        forged.idempotencyKey,
        forged.requestFingerprint,
        forged.purpose,
        forged.actor.type,
        forged.actor.id,
        forged.consentRevision,
        JSON.stringify(forged.capability),
        JSON.stringify(forged.source),
        forged.createdAt,
      ],
    );
    await store.markGenerating({
      expectedStateRevision: 0,
      leaseExpiresAt: '2026-09-10T08:02:00.000Z',
      learningProfileId: forged.learningProfileId,
      now: '2026-09-10T08:00:00.000Z',
      requestId: forged.id,
      updatedAt: '2026-09-10T08:00:00.000Z',
    });
    const version = versionFor(forged);
    await expect(
      store.complete({
        expectedStateRevision: 1,
        latestChecks: version.checks,
        learningProfileId: forged.learningProfileId,
        modelRuns: [],
        requestId: forged.id,
        version,
      }),
    ).resolves.toBe('conflict');
  });

  it('rejects replaying an authorization decision in another family space', async () => {
    if (!pool) return;
    const first = await createFixture();
    const second = await createFixture();
    const replayedAuthorization: StoredGenerationRequest = {
      ...structuredClone(second.request),
      authorization: structuredClone(first.request.authorization),
      capability: structuredClone(first.request.capability),
      id: randomUUID(),
      idempotencyKey: `cross-family-replay-${randomUUID()}`,
    };
    const store = new PostgresGeneratedLearningStore(pool);

    await expect(store.create(replayedAuthorization)).resolves.toBe(false);
    await expect(
      store.findById(replayedAuthorization.id, second.learningProfileId),
    ).resolves.toBeNull();
  });

  it('locks the current classification against concurrent knowledge-point changes', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);
    await store.create(fixture.request);
    await store.markGenerating({
      expectedStateRevision: 0,
      leaseExpiresAt: '2026-09-10T08:02:00.000Z',
      learningProfileId: fixture.learningProfileId,
      now: '2026-09-10T08:00:00.000Z',
      requestId: fixture.request.id,
      updatedAt: '2026-09-10T08:00:00.000Z',
    });
    const knowledgePointId = randomUUID();
    await mutateFixture(
      fixture,
      `INSERT INTO learning.knowledge_points
        (id, family_space_id, learning_profile_id, subject, name)
       VALUES ($1, $2, $3, 'mathematics', '整除关系')`,
      [knowledgePointId, fixture.familySpaceId, fixture.learningProfileId],
    );

    const publication = await pool.connect();
    const writer = await pool.connect();
    try {
      await publication.query('BEGIN');
      await publication.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        fixture.familySpaceId,
      ]);
      await publication.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      const locked = await publication.query<{ result: string }>(
        `SELECT learning.lock_generated_learning_publication(
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
         ) AS result`,
        [
          fixture.learningProfileId,
          fixture.familySpaceId,
          fixture.request.consentRevision,
          fixture.source.ageBand,
          fixture.source.processingJobId,
          fixture.source.confirmedContentVersionId,
          JSON.stringify(fixture.source.excerpts),
          fixture.materialId,
          fixture.source.basis.sourceVersionId,
          fixture.source.basis.selectionVersion,
          fixture.source.basis.validityEpoch,
          fixture.source.basis.contentHash,
          fixture.source.basis.kind,
          fixture.source.basis.versionLabel,
          fixture.source.classificationRevision,
          fixture.source.subject,
          fixture.source.coursePathName,
          fixture.source.unitName,
          fixture.source.knowledgePointNames,
        ],
      );
      expect(locked.rows[0]?.result).toBe('authorized');

      await writer.query('BEGIN');
      await expect(
        writer.query(
          `SELECT 1
           FROM learning.classification_versions
           WHERE id = $1
           FOR KEY SHARE NOWAIT`,
          [fixture.classificationId],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');

      await writer.query('BEGIN');
      await writer.query('SET LOCAL ROLE rhea_learning_app');
      await writer.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      await writer.query(`SET LOCAL lock_timeout = '150ms'`);
      await expect(
        writer.query(
          `INSERT INTO learning.classification_knowledge_points
            (classification_version_id, knowledge_point_id, learning_profile_id,
             is_primary, position)
           VALUES ($1, $2, $3, false, 1)`,
          [fixture.classificationId, knowledgePointId, fixture.learningProfileId],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
      await publication.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK');
      await publication.query('ROLLBACK');
      throw error;
    } finally {
      writer.release();
      publication.release();
    }

    await mutateFixture(
      fixture,
      `INSERT INTO learning.classification_knowledge_points
        (classification_version_id, knowledge_point_id, learning_profile_id,
         is_primary, position)
       VALUES ($1, $2, $3, false, 1)`,
      [fixture.classificationId, knowledgePointId, fixture.learningProfileId],
    );
    const version = versionFor(fixture.request);
    await expect(
      store.complete({
        expectedStateRevision: 1,
        latestChecks: version.checks,
        learningProfileId: fixture.learningProfileId,
        modelRuns: [
          successfulModelRunFor(fixture.request, version.createdAt, 'stale-classification-result'),
        ],
        requestId: fixture.request.id,
        version,
      }),
    ).resolves.toBe('source_changed');
  });

  it('cancels and fails requests only through revision-checked commands', async () => {
    if (!pool) return;
    const store = new PostgresGeneratedLearningStore(pool);
    const canceled = await createFixture();
    await store.create(canceled.request);
    await expect(
      store.cancel({
        expectedStateRevision: 0,
        learningProfileId: canceled.learningProfileId,
        reason: 'GENERATION_CANCELED',
        requestId: canceled.request.id,
        updatedAt: '2026-09-10T08:01:00.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      store.cancel({
        expectedStateRevision: 0,
        learningProfileId: canceled.learningProfileId,
        reason: 'GENERATION_CANCELED',
        requestId: canceled.request.id,
        updatedAt: '2026-09-10T08:02:00.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      store.findById(canceled.request.id, canceled.learningProfileId),
    ).resolves.toMatchObject({
      stateRevision: 1,
      status: 'canceled',
      unavailableReason: 'GENERATION_CANCELED',
    });

    const failed = await createFixture();
    await store.create(failed.request);
    await store.markGenerating({
      expectedStateRevision: 0,
      leaseExpiresAt: '2026-09-10T08:02:00.000Z',
      learningProfileId: failed.learningProfileId,
      now: '2026-09-10T08:00:00.000Z',
      requestId: failed.request.id,
      updatedAt: '2026-09-10T08:00:00.000Z',
    });
    const failedRun: ModelRunRecord = {
      ...successfulModelRunFor(
        failed.request,
        '2026-09-10T08:00:30.000Z',
        'rogue-provider-failure',
      ),
      observedProvider: 'unapproved-provider',
      succeeded: false,
    };
    await expect(
      store.fail({
        expectedStateRevision: 1,
        latestChecks: [],
        learningProfileId: failed.learningProfileId,
        modelRuns: [failedRun],
        reason: 'MODEL_UNAVAILABLE',
        requestId: failed.request.id,
        updatedAt: '2026-09-10T08:01:00.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      store.findById(failed.request.id, failed.learningProfileId),
    ).resolves.toMatchObject({
      stateRevision: 2,
      status: 'unavailable',
      unavailableReason: 'MODEL_UNAVAILABLE',
      modelRuns: [failedRun],
    });
  });

  it('rejects completion atomically after consent, confirmed content, or source conflicts change', async () => {
    if (!pool) return;

    const consentChanged = await createFixture();
    await expectAtomicCompletionRefusal(
      consentChanged,
      () =>
        mutateFixture(
          consentChanged,
          `UPDATE learning.family_consents
           SET status = 'withdrawn', revision = revision + 1, updated_at = now()
           WHERE family_space_id = $1 AND kind = 'ai_processing'`,
          [consentChanged.familySpaceId],
        ),
      'consent_withdrawn',
    );

    const submissionChanged = await createFixture();
    await expectAtomicCompletionRefusal(
      submissionChanged,
      () =>
        mutateFixture(
          submissionChanged,
          `UPDATE learning.processing_jobs
           SET status = 'canceled', revision = revision + 1, updated_at = now()
           WHERE id = $1`,
          [submissionChanged.processingJobId],
        ),
      'source_changed',
    );

    const sourceConflict = await createFixture();
    await expectAtomicCompletionRefusal(
      sourceConflict,
      () =>
        mutateFixture(
          sourceConflict,
          `INSERT INTO learning.learning_source_versions
            (id, material_id, family_space_id, learning_profile_id, kind,
             version_number, label, source_key, version_label, content_hash,
             conflicts_with_source_version_ids, source_confirmed_content_version_id,
             created_by_type, created_by_id, created_at)
           VALUES ($1, $2, $3, $4, 'answer', 2, '教师答案',
                   'teacher-answer:question-1', '教师答案第 2 版', $5,
                   '{}', NULL, 'learner', $4, now())`,
          [
            randomUUID(),
            sourceConflict.materialId,
            sourceConflict.familySpaceId,
            sourceConflict.learningProfileId,
            'c'.repeat(64),
          ],
        ),
      'source_changed',
    );

    const classificationChanged = await createFixture();
    await expectAtomicCompletionRefusal(
      classificationChanged,
      () =>
        mutateFixture(
          classificationChanged,
          `UPDATE learning.classification_versions
           SET revision = revision + 1
           WHERE material_id = $1`,
          [classificationChanged.materialId],
        ),
      'source_changed',
    );

    const ageBandChanged = await createFixture();
    await expectAtomicCompletionRefusal(
      ageBandChanged,
      () =>
        mutateFixture(
          ageBandChanged,
          `UPDATE learning.learning_profiles
           SET grade = 5
           WHERE id = $1`,
          [ageBandChanged.learningProfileId],
        ),
      'source_changed',
    );
  });

  it('enforces profile RLS and grants only bounded generated-learning runtime functions', async () => {
    if (!pool) return;
    const first = await createFixture();
    const second = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);
    await store.create(first.request);

    await expect(store.findById(first.request.id, second.learningProfileId)).resolves.toBeNull();

    const evidence = await pool.query(
      `SELECT
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_content_versions',
           'INSERT'
         ) AS can_insert_generated_version,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_requests',
           'INSERT'
         ) AS can_insert_generated_request,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_requests',
           'UPDATE'
         ) AS can_update_generated_request,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.domain_outbox',
           'INSERT'
         ) AS can_insert_outbox,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_source_edges',
           'INSERT'
         ) AS can_insert_generated_source_edge,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_hint_usages',
           'INSERT'
         ) AS can_insert_generated_hint_usage,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_source_edges',
           'SELECT'
         ) AS can_read_generated_source_edges,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_hint_usages',
           'SELECT'
         ) AS can_read_generated_hint_usages,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.learning_materials',
           'SELECT'
         ) AS can_read_material,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.confirmed_content_versions',
           'SELECT'
         ) AS can_read_confirmed_content,
         has_table_privilege(
           'rhea_generated_learning_app',
           'learning.family_consents',
           'SELECT'
         ) AS can_read_consent,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.authorize_generated_learning(uuid,uuid,integer,text)',
           'EXECUTE'
         ) AS can_authorize,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.lock_generated_learning_publication(uuid,uuid,integer,text,uuid,uuid,jsonb,uuid,uuid,integer,integer,text,text,text,integer,text,text,text,text[])',
           'EXECUTE'
         ) AS can_lock_publication,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_checks_pass(jsonb)',
           'EXECUTE'
         ) AS can_check_publication_directly,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.generated_learning_source_key(jsonb)',
           'EXECUTE'
         ) AS can_compute_source_key_directly,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.create_generated_learning_request(uuid,uuid,uuid,uuid,text,text,text,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,uuid,smallint,timestamp with time zone,integer,jsonb,jsonb,timestamp with time zone,timestamp with time zone)',
           'EXECUTE'
         ) AS can_create,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.claim_generated_learning_request(uuid,uuid,integer,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
           'EXECUTE'
         ) AS can_claim,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.cancel_generated_learning_request(uuid,uuid,integer,uuid,timestamp with time zone)',
           'EXECUTE'
         ) AS can_cancel,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.fail_generated_learning_request(uuid,uuid,integer,text,jsonb,jsonb,uuid,timestamp with time zone)',
           'EXECUTE'
         ) AS can_fail,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.complete_generated_learning_request(uuid,uuid,integer,uuid,uuid,integer,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone)',
           'EXECUTE'
         ) AS can_complete,
         has_function_privilege(
           'rhea_generated_learning_app',
           'metrics.lock_current_capability_authorization(text,text,bigint,text,text)',
           'EXECUTE'
         ) AS can_lock_capability_authorization,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.reveal_generated_learning_hint(uuid,uuid,uuid,smallint,smallint,uuid,text,uuid,timestamp with time zone)',
           'EXECUTE'
         ) AS can_reveal_hint,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.resolve_generated_learning_eligibility(uuid,uuid)',
           'EXECUTE'
         ) AS can_resolve_eligibility_directly,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.lock_current_generated_learning_eligibility(uuid,uuid,integer,text)',
           'EXECUTE'
         ) AS can_lock_eligibility_directly,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.lock_current_generated_learning_content(uuid,uuid,uuid,jsonb)',
           'EXECUTE'
         ) AS can_lock_content_directly,
         has_function_privilege(
           'rhea_generated_learning_app',
           'learning.lock_current_generated_learning_basis(uuid,uuid,uuid,uuid,uuid,integer,integer,text,text,text,integer,text,text,text,text[])',
           'EXECUTE'
         ) AS can_lock_basis_directly,
         has_schema_privilege(
           'rhea_generated_learning_app', 'safety', 'USAGE'
         ) AS can_use_safety,
         has_schema_privilege(
           'rhea_generated_learning_app', 'metrics', 'USAGE'
         ) AS can_use_metrics,
         (
           SELECT bool_and(class.relrowsecurity AND class.relforcerowsecurity)
           FROM pg_catalog.pg_class class
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
           WHERE namespace.nspname = 'learning'
             AND class.relname LIKE 'generated_learning_%'
             AND class.relkind = 'r'
         ) AS all_generated_tables_force_rls`,
    );
    expect(evidence.rows[0]).toEqual({
      all_generated_tables_force_rls: true,
      can_authorize: true,
      can_cancel: true,
      can_check_publication_directly: false,
      can_claim: true,
      can_compute_source_key_directly: false,
      can_complete: true,
      can_create: true,
      can_fail: true,
      can_insert_generated_hint_usage: false,
      can_insert_generated_request: false,
      can_insert_generated_source_edge: false,
      can_insert_generated_version: false,
      can_insert_outbox: false,
      can_lock_capability_authorization: false,
      can_read_generated_hint_usages: false,
      can_read_generated_source_edges: false,
      can_lock_basis_directly: false,
      can_lock_content_directly: false,
      can_lock_eligibility_directly: false,
      can_lock_publication: false,
      can_read_confirmed_content: false,
      can_read_consent: false,
      can_read_material: false,
      can_reveal_hint: true,
      can_resolve_eligibility_directly: false,
      can_update_generated_request: false,
      can_use_metrics: false,
      can_use_safety: false,
    });

    const bypass = await pool.connect();
    try {
      await bypass.query('BEGIN');
      await bypass.query('SET LOCAL ROLE rhea_generated_learning_app');
      await bypass.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        first.learningProfileId,
      ]);
      await expect(
        bypass.query(
          `UPDATE learning.generated_learning_requests
           SET state_revision = state_revision + 1
           WHERE id = $1`,
          [first.request.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await bypass.query('ROLLBACK');
      bypass.release();
    }
  });

  it('rejects cross-scope material, current-version, and hint-version relationships', async () => {
    if (!pool) return;
    const first = await createFixture();
    const second = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);
    const mismatchedRequest: StoredGenerationRequest = {
      ...structuredClone(first.request),
      id: randomUUID(),
      idempotencyKey: `request-${randomUUID()}`,
      materialId: second.materialId,
      source: {
        ...structuredClone(first.source),
        basis: { ...structuredClone(first.source.basis), materialId: second.materialId },
      },
    };

    await expect(store.create(mismatchedRequest)).rejects.toMatchObject({
      code: '23503',
      constraint: 'generated_learning_requests_material_fk',
    });

    const firstVersion = await publishFixture(first, store);
    const secondVersion = await publishFixture(second, store);
    await expect(
      pool.query(
        `INSERT INTO learning.generated_learning_content_versions
          (id, request_id, family_space_id, learning_profile_id, material_id,
           source_key, revision, predecessor_id, content_state, capability,
           source_snapshot, pack, checks, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8,
                 $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
        [
          randomUUID(),
          first.request.id,
          second.familySpaceId,
          second.learningProfileId,
          second.materialId,
          generatedLearningSourceKey(second.source),
          secondVersion.id,
          secondVersion.contentState,
          JSON.stringify(secondVersion.capability),
          JSON.stringify(secondVersion.source),
          JSON.stringify(secondVersion.pack),
          JSON.stringify(secondVersion.checks),
          secondVersion.createdAt,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'generated_learning_content_request_fk',
    });
    await expect(
      pool.query(
        `UPDATE learning.generated_learning_requests
         SET current_version_id = $1
         WHERE id = $2`,
        [secondVersion.id, first.request.id],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'generated_learning_requests_current_version_fk',
    });

    await expect(
      pool.query(
        `INSERT INTO learning.generated_learning_hint_usages
          (id, request_id, version_id, family_space_id, learning_profile_id,
           actor_type, actor_id, level, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'learner', $5, 1, now())`,
        [
          randomUUID(),
          first.request.id,
          secondVersion.id,
          first.familySpaceId,
          first.learningProfileId,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'generated_learning_hint_usages_version_fk',
    });

    await expect(store.findById(first.request.id, first.learningProfileId)).resolves.toMatchObject({
      currentVersionId: firstVersion.id,
      revealedHintLevel: 0,
    });
  });

  it('rechecks consent, source freshness, and expected level in the hint transaction', async () => {
    if (!pool) return;

    const consentChanged = await createFixture();
    const consentStore = new PostgresGeneratedLearningStore(pool);
    const consentVersion = await publishFixture(consentChanged, consentStore);
    await mutateFixture(
      consentChanged,
      `UPDATE learning.family_consents
       SET status = 'withdrawn', revision = revision + 1, updated_at = now()
       WHERE family_space_id = $1 AND kind = 'ai_processing'`,
      [consentChanged.familySpaceId],
    );
    await expect(
      consentStore.recordHintUsage({
        actor: consentChanged.request.actor,
        expectedLevel: 0,
        learningProfileId: consentChanged.learningProfileId,
        nextLevel: 1,
        occurredAt: '2026-09-10T08:03:00.000Z',
        requestId: consentChanged.request.id,
        versionId: consentVersion.id,
      }),
    ).resolves.toBe('consent_withdrawn');

    const sourceChanged = await createFixture();
    const sourceStore = new PostgresGeneratedLearningStore(pool);
    const sourceVersion = await publishFixture(sourceChanged, sourceStore);
    await mutateFixture(
      sourceChanged,
      `INSERT INTO learning.learning_source_versions
        (id, material_id, family_space_id, learning_profile_id, kind,
         version_number, label, source_key, version_label, content_hash,
         conflicts_with_source_version_ids, source_confirmed_content_version_id,
         created_by_type, created_by_id, created_at)
       VALUES ($1, $2, $3, $4, 'answer', 2, '教师答案',
               'teacher-answer:question-1', '教师答案第 2 版', $5,
               '{}', NULL, 'learner', $4, now())`,
      [
        randomUUID(),
        sourceChanged.materialId,
        sourceChanged.familySpaceId,
        sourceChanged.learningProfileId,
        'd'.repeat(64),
      ],
    );
    await expect(
      sourceStore.recordHintUsage({
        actor: sourceChanged.request.actor,
        expectedLevel: 0,
        learningProfileId: sourceChanged.learningProfileId,
        nextLevel: 1,
        occurredAt: '2026-09-10T08:03:00.000Z',
        requestId: sourceChanged.request.id,
        versionId: sourceVersion.id,
      }),
    ).resolves.toBe('source_changed');

    const expectedLevelChanged = await createFixture();
    const levelStore = new PostgresGeneratedLearningStore(pool);
    const levelVersion = await publishFixture(expectedLevelChanged, levelStore);
    await expect(
      levelStore.recordHintUsage({
        actor: expectedLevelChanged.request.actor,
        expectedLevel: 1,
        learningProfileId: expectedLevelChanged.learningProfileId,
        nextLevel: 2,
        occurredAt: '2026-09-10T08:03:00.000Z',
        requestId: expectedLevelChanged.request.id,
        versionId: levelVersion.id,
      }),
    ).resolves.toBe('conflict');

    await expect(
      levelStore.recordHintUsage({
        actor: expectedLevelChanged.request.actor,
        expectedLevel: 0,
        learningProfileId: expectedLevelChanged.learningProfileId,
        nextLevel: 2,
        occurredAt: '2026-09-10T08:03:00.000Z',
        requestId: expectedLevelChanged.request.id,
        versionId: levelVersion.id,
      }),
    ).resolves.toBe('conflict');

    for (const fixture of [consentChanged, sourceChanged, expectedLevelChanged]) {
      await expect(
        levelStore.findById(fixture.request.id, fixture.learningProfileId),
      ).resolves.toMatchObject({ revealedHintLevel: 0 });
    }

    const hintRows = await pool.connect();
    try {
      await hintRows.query('BEGIN');
      await hintRows.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        consentChanged.learningProfileId,
      ]);
      const usages = await hintRows.query(
        `SELECT 1 FROM learning.generated_learning_hint_usages WHERE request_id = $1`,
        [consentChanged.request.id],
      );
      expect(usages.rows).toHaveLength(0);
      await hintRows.query('COMMIT');
    } catch (error) {
      await hintRows.query('ROLLBACK');
      throw error;
    } finally {
      hintRows.release();
    }
  });

  it('hydrates pre-lineage rows as unverified and refuses to publish them', async () => {
    if (!pool) return;
    const fixture = await createFixture();
    const legacyRequestId = randomUUID();
    await pool.query(
      `INSERT INTO learning.generated_learning_requests
        (id, family_space_id, learning_profile_id, material_id, idempotency_key,
         request_fingerprint, purpose, actor_type, actor_id, consent_revision,
         capability, source_snapshot, source_key, status, unavailable_reason,
         current_version_id, revealed_hint_level, processing_lease_expires_at,
         state_revision, latest_checks, model_runs, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'learning_pack', 'learner', $3, 1,
               $7::jsonb, $8::jsonb, $9, 'queued', NULL, NULL, 0, NULL, 0,
               '[]'::jsonb, '[]'::jsonb, $10, $10)`,
      [
        legacyRequestId,
        fixture.familySpaceId,
        fixture.learningProfileId,
        fixture.materialId,
        `legacy-request-${randomUUID()}`,
        'e'.repeat(64),
        JSON.stringify(fixture.request.capability),
        JSON.stringify(fixture.source),
        generatedLearningSourceKey(fixture.source),
        '2026-09-10T07:59:00.000Z',
      ],
    );
    const store = new PostgresGeneratedLearningStore(pool);
    await expect(store.findById(legacyRequestId, fixture.learningProfileId)).resolves.toMatchObject(
      {
        authorization: {
          containmentEpoch: 0,
          degradedReason: 'NO_SIGNED_CAPABILITY',
          decisionId: `legacy-unverified:${legacyRequestId}`,
          issuedAt: '2026-09-10T07:59:00.000Z',
        },
        capability: null,
        currentVersionId: null,
        modelRuns: [],
        status: 'queued',
        versions: [],
      },
    );
    await expect(
      store.markGenerating({
        expectedStateRevision: 0,
        leaseExpiresAt: '2026-09-10T08:02:00.000Z',
        learningProfileId: fixture.learningProfileId,
        now: '2026-09-10T08:00:00.000Z',
        requestId: legacyRequestId,
        updatedAt: '2026-09-10T08:00:00.000Z',
      }),
    ).resolves.toBe(true);
    const forgedVersion = versionFor(fixture.request);
    await expect(
      store.complete({
        expectedStateRevision: 1,
        latestChecks: forgedVersion.checks,
        learningProfileId: fixture.learningProfileId,
        modelRuns: [
          successfulModelRunFor(fixture.request, forgedVersion.createdAt, 'legacy-result'),
        ],
        requestId: legacyRequestId,
        version: forgedVersion,
      }),
    ).resolves.toBe('conflict');
    const evidence = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM learning.generated_learning_content_versions
       WHERE request_id = $1`,
      [legacyRequestId],
    );
    expect(evidence.rows[0]?.count).toBe('0');
  });

  it('persists a recoverable degraded request without invoking or publishing a capability', async () => {
    if (!pool || !noSignedCapabilityDecision) return;
    const fixture = await createFixture(noSignedCapabilityFamilySpaceId);
    const degradedDecision = noSignedCapabilityDecision;
    expect(degradedDecision).toMatchObject({
      degradedReason: 'NO_SIGNED_CAPABILITY',
      primary: null,
      status: 'degraded',
    });
    const unavailable: StoredGenerationRequest = {
      ...structuredClone(fixture.request),
      authorization: {
        containmentEpoch: degradedDecision.containmentEpoch,
        degradedReason: degradedDecision.degradedReason,
        decisionId: degradedDecision.decisionId,
        issuedAt: degradedDecision.issuedAt,
      },
      capability: null,
      modelRuns: [],
      status: 'unavailable',
      unavailableReason: 'CAPABILITY_UNAVAILABLE',
    };
    const store = new PostgresGeneratedLearningStore(pool);

    await expect(store.create(unavailable)).resolves.toBe(true);
    await expect(
      store.markGenerating({
        expectedStateRevision: 0,
        leaseExpiresAt: '2026-09-10T08:02:00.000Z',
        learningProfileId: unavailable.learningProfileId,
        now: '2026-09-10T08:00:00.000Z',
        requestId: unavailable.id,
        updatedAt: '2026-09-10T08:00:00.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      store.findById(unavailable.id, unavailable.learningProfileId),
    ).resolves.toMatchObject({
      authorization: unavailable.authorization,
      capability: null,
      currentVersionId: null,
      modelRuns: [],
      status: 'unavailable',
      unavailableReason: 'CAPABILITY_UNAVAILABLE',
      versions: [],
    });

    const evidence = await pool.query<{ published_count: string; version_count: string }>(
      `SELECT
         (SELECT count(*)::text
          FROM learning.generated_learning_content_versions
          WHERE request_id = $1) AS version_count,
         (SELECT count(*)::text
          FROM learning.domain_outbox
          WHERE aggregate_id = $1
            AND event_type = 'generated_learning.published') AS published_count`,
      [unavailable.id],
    );
    expect(evidence.rows[0]).toEqual({ published_count: '0', version_count: '0' });
  });

  it('rejects a generated result atomically when its capability is contained before publication', async () => {
    if (!pool || !qualityControl) return;
    const fixture = await createFixture();
    const store = new PostgresGeneratedLearningStore(pool);
    await expect(store.create(fixture.request)).resolves.toBe(true);
    await expect(
      store.markGenerating({
        expectedStateRevision: 0,
        leaseExpiresAt: '2026-09-10T08:02:00.000Z',
        learningProfileId: fixture.learningProfileId,
        now: '2026-09-10T08:00:00.000Z',
        requestId: fixture.request.id,
        updatedAt: '2026-09-10T08:00:00.000Z',
      }),
    ).resolves.toBe(true);
    const version = versionFor(fixture.request);
    await qualityControl.containCapability({
      commandId: `contain-generated-learning-${randomUUID()}`,
      containedAt: '2026-09-10T08:00:30.000Z',
      expectedContainmentEpoch: fixture.request.authorization.containmentEpoch,
      reason: 'critical generated-learning quality regression',
      target: { id: fixture.request.capability!.id, kind: 'capability_version' },
    });

    await expect(
      store.complete({
        expectedStateRevision: 1,
        latestChecks: version.checks,
        learningProfileId: fixture.learningProfileId,
        modelRuns: [
          {
            attempt: 1,
            authorizationDecisionId: fixture.request.authorization.decisionId,
            capabilityVersionId: fixture.request.capability!.id,
            externalTraceId: 'late-contained-result',
            finishedAt: version.createdAt,
            inputTokens: 100,
            modelOrEngineVersion: fixture.request.capability!.modelOrEngine.version,
            observedProvider: fixture.request.capability!.provider.id,
            outputTokens: 200,
            promptOrConfigVersion: fixture.request.capability!.promptOrConfig.version,
            provider: fixture.request.capability!.provider.id,
            providerVersion: fixture.request.capability!.provider.version,
            succeeded: true,
          },
        ],
        requestId: fixture.request.id,
        version,
      }),
    ).resolves.toBe('capability_contained');
    await expect(
      store.findById(fixture.request.id, fixture.learningProfileId),
    ).resolves.toMatchObject({
      currentVersionId: null,
      modelRuns: [],
      status: 'generating',
      versions: [],
    });

    const evidence = await pool.query<{ published_count: string; version_count: string }>(
      `SELECT
         (SELECT count(*)::text
          FROM learning.generated_learning_content_versions
          WHERE request_id = $1) AS version_count,
         (SELECT count(*)::text
          FROM learning.domain_outbox
          WHERE aggregate_id = $1
            AND event_type = 'generated_learning.published') AS published_count`,
      [fixture.request.id],
    );
    expect(evidence.rows[0]).toEqual({ published_count: '0', version_count: '0' });
  });
});
