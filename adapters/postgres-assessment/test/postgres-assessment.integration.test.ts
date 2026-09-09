import { randomUUID } from 'node:crypto';

import { AssessmentService } from '@rhea/assessment';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { LearningContentService } from '@rhea/learning-content';
import { PostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAssessmentStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
});

afterAll(async () => pool?.end());

async function createLearningMaterial() {
  if (!pool) throw new Error('Database is not configured');
  const familySpaceId = randomUUID();
  const learningProfileId = randomUUID();
  const uploadSessionId = randomUUID();
  const processingJobId = randomUUID();
  const candidateId = randomUUID();
  const confirmedContentVersionId = randomUUID();
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
      readingOrder: 1,
      text: '41',
    },
  ];
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
    await setup.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
      familySpaceId,
      '客观题批改测试家庭',
    ]);
    await setup.query(
      `INSERT INTO learning.learning_profiles
        (id, family_space_id, display_name, grade, pin_hash)
       VALUES ($1, $2, '小禾', 3, 'test-hash')`,
      [learningProfileId, familySpaceId],
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
      `INSERT INTO learning.recognition_candidates
        (id, job_id, learning_profile_id, adapter_version, source_hash, regions)
       VALUES ($1, $2, $3, 'test-v1', $4, $5::jsonb)`,
      [candidateId, processingJobId, learningProfileId, 'a'.repeat(64), JSON.stringify(regions)],
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
      coursePathName: '沪教版三年级上册',
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

describeWithDatabase('PostgreSQL assessment adapter', () => {
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
        `SELECT event_type
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
      expect(outbox.rows).toHaveLength(3);
      expect(outbox.rows.map(({ event_type }) => event_type)).toEqual(
        expect.arrayContaining([
          'objective_assessment.graded',
          'objective_assessment.disputed',
          'objective_assessment.dispute_resolved',
        ]),
      );
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows.map(({ action }) => action)).toEqual(
        expect.arrayContaining(['assessment.downstream_reference.read', 'assessment.read']),
      );
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
         has_function_privilege(
           'rhea_assessment_app',
           'learning.lock_current_assessment_basis(uuid,uuid,uuid,integer,integer,text,text,text)',
           'EXECUTE'
         ) AS can_lock_current_basis,
         has_schema_privilege('rhea_assessment_app', 'safety', 'USAGE') AS can_use_safety`,
    );
    expect(evidence.rows[0]).toEqual({
      can_lock_current_basis: true,
      can_mutate_material: false,
      can_read_material: false,
      can_use_safety: false,
    });
  });
});
