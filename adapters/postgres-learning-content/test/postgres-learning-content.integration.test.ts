import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { LearningContentService } from '@rhea/learning-content';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresLearningContentStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) await applyMigrations(pool, await loadDefaultMigrations());
});

afterAll(async () => pool?.end());

async function createConfirmedContent() {
  if (!pool) throw new Error('Database is not configured');
  const familySpaceId = randomUUID();
  const learningProfileId = randomUUID();
  const uploadSessionId = randomUUID();
  const processingJobId = randomUUID();
  const candidateId = randomUUID();
  const confirmedContentVersionId = randomUUID();
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
    await setup.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
      familySpaceId,
      '学习内容适配器测试',
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
       VALUES ($1, $2, $3, 'test-v1', $4, '[]')`,
      [candidateId, processingJobId, learningProfileId, 'a'.repeat(64)],
    );
    await setup.query(
      `INSERT INTO learning.confirmed_content_versions
        (id, job_id, learning_profile_id, version, source_candidate_id, source_hash,
         regions, confirmed_by_learning_profile_id, confirmed_at)
       VALUES ($1, $2, $3, 1, $4, $5, '[]', $3, now())`,
      [confirmedContentVersionId, processingJobId, learningProfileId, candidateId, 'a'.repeat(64)],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally {
    setup.release();
  }
  return { confirmedContentVersionId, familySpaceId, learningProfileId };
}

describeWithDatabase('PostgreSQL learning content adapter', () => {
  it('persists reusable taxonomy and immutable classification/source/basis histories', async () => {
    if (!pool) return;
    const fixture = await createConfirmedContent();
    const service = new LearningContentService({ store: new PostgresLearningContentStore(pool) });
    const material = await service.organizeConfirmedContent({
      actor: { id: fixture.learningProfileId, type: 'learner' },
      classification: {
        coursePathName: '沪教版三年级上册',
        knowledgePointNames: ['两位数乘法'],
        primaryKnowledgePointName: '两位数乘法',
        primarySubject: 'mathematics',
        relatedSubjects: ['science'],
        unitName: '乘法',
      },
      confirmedContentVersion: 1,
      confirmedContentVersionId: fixture.confirmedContentVersionId,
      familySpaceId: fixture.familySpaceId,
      learningProfileId: fixture.learningProfileId,
      sourceHash: 'a'.repeat(64),
    });
    await service.correctClassification({
      actor: { id: fixture.learningProfileId, type: 'learner' },
      classification: {
        coursePathName: '沪教版三年级上册',
        knowledgePointNames: ['两位数乘法', '估算'],
        primaryKnowledgePointName: '两位数乘法',
        primarySubject: 'mathematics',
        relatedSubjects: [],
        unitName: '乘法',
      },
      learningProfileId: fixture.learningProfileId,
      materialId: material.id,
      reason: '补充估算知识点',
    });
    await service.addSourceVersion({
      actor: { id: fixture.learningProfileId, type: 'learner' },
      contentHash: 'b'.repeat(64),
      kind: 'answer',
      label: '教师答案',
      learningProfileId: fixture.learningProfileId,
      materialId: material.id,
      sourceKey: 'teacher-answer:q1',
      versionLabel: '第 1 版',
    });
    const withAnswer = await service.addSourceVersion({
      actor: { id: fixture.learningProfileId, type: 'learner' },
      contentHash: 'c'.repeat(64),
      kind: 'answer',
      label: '教师修订答案',
      learningProfileId: fixture.learningProfileId,
      materialId: material.id,
      sourceKey: 'teacher-answer:q1',
      versionLabel: '第 2 版',
    });
    const answer = withAnswer.sourceVersions.at(-1)!;
    const selected = await service.selectCurrentBasis({
      actor: { id: randomUUID(), type: 'guardian' },
      learningProfileId: fixture.learningProfileId,
      materialId: material.id,
      reason: '采用教师答案',
      sourceVersionId: answer.id,
    });

    expect(selected.currentClassification).toMatchObject({
      knowledgePoints: expect.arrayContaining([expect.objectContaining({ name: '估算' })]),
      revision: 2,
    });
    expect(selected).toMatchObject({
      basis: { currentSourceVersionId: answer.id, hasConflict: true, selectionRevision: 2 },
    });
    await service.getMaterial({
      actor: { id: fixture.learningProfileId, type: 'learner' },
      learningProfileId: fixture.learningProfileId,
      materialId: material.id,
    });
    await service.getCurrentBasisReference({
      actor: { id: fixture.learningProfileId, type: 'learner' },
      learningProfileId: fixture.learningProfileId,
      materialId: material.id,
    });
    const evidence = await pool.connect();
    try {
      await evidence.query('BEGIN');
      await evidence.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        fixture.learningProfileId,
      ]);
      const outbox = await evidence.query(
        'SELECT event_type FROM learning.domain_outbox WHERE aggregate_id = $1 ORDER BY occurred_at, id',
        [material.id],
      );
      const audit = await evidence.query(
        'SELECT action FROM learning.learning_access_audit WHERE resource_id = $1',
        [material.id],
      );
      expect(outbox.rows).toHaveLength(5);
      expect(audit.rows).toHaveLength(7);
      await evidence.query('COMMIT');
    } catch (error) {
      await evidence.query('ROLLBACK');
      throw error;
    } finally {
      evidence.release();
    }
    await expect(
      service.getMaterial({
        actor: { id: fixture.learningProfileId, type: 'learner' },
        learningProfileId: randomUUID(),
        materialId: material.id,
      }),
    ).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND' });
  });
});
