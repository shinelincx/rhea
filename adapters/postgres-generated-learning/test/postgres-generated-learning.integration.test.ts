import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import {
  generatedLearningSourceKey,
  type GeneratedLearningContentVersion,
  type GenerationSourceSnapshot,
  type StoredGenerationRequest,
} from '@rhea/generated-learning';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresGeneratedLearningStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
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

async function createFixture(): Promise<Fixture> {
  if (!pool) throw new Error('Database is not configured');
  const familySpaceId = randomUUID();
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
        (id, job_id, learning_profile_id, adapter_version, source_hash, regions)
       VALUES ($1, $2, $3, 'fixed-recognition-v1', $4, $5::jsonb)`,
      [candidateId, processingJobId, learningProfileId, sourceHash, JSON.stringify(regions)],
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
  const request: StoredGenerationRequest = {
    actor: { id: learningProfileId, type: 'learner' },
    capability: {
      adapterVersion: 'fixed-adapter-v1',
      availability: 'approved',
      id: 'learning-pack-capability-v1',
      modelVersion: 'fixed-model-v1',
      policyVersion: 'child-learning-policy-v1',
      region: 'test-local',
      templateVersion: 'lesson-support-template-v1',
    },
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
  return {
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
         $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18,
         $19, $20::jsonb, $21::jsonb, $22, $23
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
        JSON.stringify(request.capability),
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
      modelRuns: [],
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
      modelRuns: [],
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
        capability: fixture.request.capability,
        consentRevision: fixture.request.consentRevision,
        familySpaceId: fixture.familySpaceId,
        learningProfileId: fixture.learningProfileId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.authorize({
        ageBand: 'lower_primary',
        capability: fixture.request.capability,
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
            externalTraceId: 'trace-1',
            finishedAt: version.createdAt,
            inputTokens: 100,
            outputTokens: 200,
            provider: 'fixed-test-model',
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
      currentVersionId: version.id,
      latestChecks: version.checks,
      modelRuns: [{ externalTraceId: 'trace-1', succeeded: true }],
      status: 'ready',
      versions: [{ id: version.id, pack: version.pack, source: fixture.source }],
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
      const [events, edges] = await Promise.all([
        evidence.query(
          `SELECT event_type FROM learning.domain_outbox
           WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
          [fixture.request.id],
        ),
        evidence.query(
          `SELECT source_type, source_id, usage
           FROM learning.generated_learning_source_edges
           WHERE generated_version_id = $1 ORDER BY position`,
          [version.id],
        ),
      ]);
      expect(events.rows.map(({ event_type }) => event_type)).toEqual([
        'generated_learning.requested',
        'generated_learning.published',
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
        modelRuns: [],
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
           $12::jsonb, $13::jsonb, $14
         ) AS result`,
        [
          fixture.request.id,
          fixture.learningProfileId,
          1,
          version.id,
          version.predecessorId,
          version.revision,
          version.contentState,
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
        modelRuns: [],
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
    await expect(
      store.fail({
        expectedStateRevision: 1,
        latestChecks: [],
        learningProfileId: failed.learningProfileId,
        modelRuns: [],
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

  it('enforces profile RLS and grants only generated-learning top-level functions', async () => {
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
           'learning.create_generated_learning_request(uuid,uuid,uuid,uuid,text,text,text,text,uuid,integer,jsonb,jsonb,text,text,text,uuid,smallint,timestamp with time zone,integer,jsonb,jsonb,timestamp with time zone,timestamp with time zone)',
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
           'learning.complete_generated_learning_request(uuid,uuid,integer,uuid,uuid,integer,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone)',
           'EXECUTE'
         ) AS can_complete,
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
});
