import { randomUUID } from 'node:crypto';

import { AssessmentService, type ObjectiveGradingRule } from '@rhea/assessment';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { LearningContentService, type Subject } from '@rhea/learning-content';
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
      text: input.questionText ?? '6 × 7 = ?',
    },
    {
      confidence: 0.99,
      id: responseRegionId,
      kind: 'answer',
      lowConfidence: false,
      pageId: 'page-1',
      polygon: [],
      readingOrder: 1,
      text: input.answerText ?? '41',
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

describeWithDatabase('PostgreSQL assessment adapter', () => {
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
         has_schema_privilege('rhea_assessment_app', 'safety', 'USAGE') AS can_use_safety`,
    );
    expect(evidence.rows[0]).toEqual({
      can_confirm_rule: true,
      can_insert_rule_directly: false,
      can_lock_current_basis: true,
      can_mutate_material: false,
      can_read_material: false,
      can_use_safety: false,
    });
  });
});
