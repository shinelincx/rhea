import { createHash, randomUUID } from 'node:crypto';

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
  const capabilityVersionId = randomUUID();
  const authorizationDecisionId = randomUUID();
  const releaseId = randomUUID();
  const capability = {
    adapter: { id: 'learning-content-fixture', version: 'test-v1' },
    artifactHash: 'd'.repeat(64),
    capabilityKey: 'ocr.recognition',
    id: capabilityVersionId,
    implementedBy: 'learning-content-integration-test',
    kind: 'ocr',
    modelOrEngine: { id: 'fixture-engine', version: 'engine-v1' },
    policyVersion: 'fixture-policy-v1',
    promptOrConfig: { kind: 'config', version: 'fixture-config-v1' },
    provider: { id: 'fixture-provider', version: 'provider-v1' },
    region: 'cn-shanghai',
    registeredAt: '2026-09-10T08:00:00.000Z',
    requiredSlicePolicyVersion: 'learning-content-fixture-policy-v1',
    templateVersion: 'not-applicable-v1',
  } as const;
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
      `INSERT INTO metrics.quality_gate_policies
        (version, minimum_sample_size, required_signoff_roles, registered_at)
       VALUES ($1, 1, ARRAY['quality_owner', 'domain_reviewer', 'child_safety'], $2)`,
      [capability.requiredSlicePolicyVersion, capability.registeredAt],
    );
    await setup.query(
      `INSERT INTO metrics.capability_versions
        (id, capability_key, kind, implemented_by, provider_id, provider_version,
         model_or_engine_id, model_or_engine_version, adapter_id, adapter_version,
         prompt_or_config_kind, prompt_or_config_version, template_version, policy_version,
         required_slice_policy_version, region, registered_at, artifact_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18)`,
      [
        capability.id,
        capability.capabilityKey,
        capability.kind,
        capability.implementedBy,
        capability.provider.id,
        capability.provider.version,
        capability.modelOrEngine.id,
        capability.modelOrEngine.version,
        capability.adapter.id,
        capability.adapter.version,
        capability.promptOrConfig.kind,
        capability.promptOrConfig.version,
        capability.templateVersion,
        capability.policyVersion,
        capability.requiredSlicePolicyVersion,
        capability.region,
        capability.registeredAt,
        capability.artifactHash,
      ],
    );
    await setup.query(
      `INSERT INTO metrics.capability_release_revisions
        (id, capability_key, kind, revision, stage, capability_version_id,
         fallback_version_id, rollout_basis_points, allowed_use_slices, predecessor_id,
         action, reason_code, changed_by, changed_at)
       VALUES ($1, $2, $3, 1, 'general', $4, NULL, 10000, $5, NULL,
               'advance', 'fixture', 'integration-test', $6)`,
      [
        releaseId,
        capability.capabilityKey,
        capability.kind,
        capability.id,
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
        capability.registeredAt,
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
        capability.capabilityKey,
        capability.kind,
        createHash('sha256').update(familySpaceId).digest('hex'),
        releaseId,
        capability.id,
        capability.registeredAt,
      ],
    );
    await setup.query(
      `INSERT INTO learning.recognition_candidates
        (id, job_id, family_space_id, learning_profile_id, adapter_version,
         finished_at, source_hash, regions, capability_key, capability_kind,
         capability_version_id, authorization_decision_id,
         authorization_containment_epoch, authorization_family_space_hash,
         capability_snapshot)
       VALUES ($1, $2, $3, $4, 'test-v1', $5, $6, '[]', $7, $8, $9, $10,
               0, $11, $12)`,
      [
        candidateId,
        processingJobId,
        familySpaceId,
        learningProfileId,
        capability.registeredAt,
        'a'.repeat(64),
        capability.capabilityKey,
        capability.kind,
        capability.id,
        authorizationDecisionId,
        createHash('sha256').update(familySpaceId).digest('hex'),
        JSON.stringify(capability),
      ],
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
