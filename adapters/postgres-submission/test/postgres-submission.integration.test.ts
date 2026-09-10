import { createHash, randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import {
  MemoryObjectStore,
  SubmissionService,
  deterministicFileInspection,
  deterministicRecognition,
  type RecognitionCapabilityAuthorizationPort,
  type RecognitionCandidate,
} from '@rhea/submission';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSubmissionStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

const capability: RecognitionCandidate['authorization']['capabilityVersion'] = {
  adapter: { id: 'deterministic-ocr', version: 'deterministic-ocr-v1' },
  artifactHash: 'a'.repeat(64),
  capabilityKey: 'ocr.recognition',
  id: '11111111-1111-4111-8111-111111111111',
  implementedBy: '33333333-3333-4333-8333-333333333333',
  kind: 'ocr',
  modelOrEngine: { id: 'deterministic-engine', version: 'engine-v1' },
  policyVersion: 'ocr-policy-v1',
  promptOrConfig: { kind: 'config', version: 'ocr-config-v1' },
  provider: { id: 'rhea-deterministic', version: 'provider-contract-v1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-10T08:00:00.000Z',
  requiredSlicePolicyVersion: 'ocr-quality-policy-v1',
  templateVersion: 'not-applicable-v1',
};

const capabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
  async authorizeCapability(input) {
    return {
      containmentEpoch: 0,
      decisionId: '22222222-2222-4222-8222-222222222222',
      degradedReason: null,
      issuedAt: '2026-09-10T10:14:59.000Z',
      primary: { capabilityVersion: capability, rolloutStage: 'general' },
      rolloutBucket: 321,
      scope: input,
      shadow: null,
      status: 'authorized',
    };
  },
  async revalidateAuthorization(input) {
    return {
      capabilityVersion: capability,
      containmentEpoch: input.expectedContainmentEpoch,
      decisionId: input.decisionId,
      status: 'authorized',
    };
  },
};

beforeAll(async () => {
  if (pool) {
    await applyMigrations(pool, await loadDefaultMigrations());
  }
});

afterAll(async () => pool?.end());

describeWithDatabase('PostgreSQL submission adapter', () => {
  it('persists immutable lineage, isolates profiles, and rejects stale authorization atomically', async () => {
    if (!pool) return;
    const familySpaceId = randomUUID();
    const learningProfileId = randomUUID();
    const setupClient = await pool.connect();
    try {
      await setupClient.query('BEGIN');
      await setupClient.query(
        `INSERT INTO metrics.quality_gate_policies
          (version, minimum_sample_size, required_signoff_roles, registered_at)
         VALUES ($1, 1, ARRAY['quality_owner', 'domain_reviewer', 'child_safety'], $2)
         ON CONFLICT (version) DO NOTHING`,
        [capability.requiredSlicePolicyVersion, capability.registeredAt],
      );
      await setupClient.query(
        `INSERT INTO metrics.capability_versions
          (id, capability_key, kind, implemented_by, provider_id, provider_version,
           model_or_engine_id, model_or_engine_version, adapter_id, adapter_version,
           prompt_or_config_kind, prompt_or_config_version, template_version, policy_version,
           required_slice_policy_version, region, registered_at, artifact_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18)
         ON CONFLICT (id) DO NOTHING`,
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
      await setupClient.query(
        `INSERT INTO metrics.quality_card_revisions
          (id, capability_version_id, policy_version, revision, evidence_hash, status, created_at)
         VALUES ($1, $2, $3, 1, $4, 'passed', $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          '44444444-4444-4444-8444-444444444444',
          capability.id,
          capability.requiredSlicePolicyVersion,
          'c'.repeat(64),
          capability.registeredAt,
        ],
      );
      for (const [signerId, role] of [
        ['quality-owner-1', 'quality_owner'],
        ['domain-reviewer-1', 'domain_reviewer'],
        ['child-safety-1', 'child_safety'],
      ] as const) {
        await setupClient.query(
          `INSERT INTO metrics.quality_signoffs
            (capability_version_id, quality_card_id, policy_version, evidence_hash,
             signer_id, signer_role, signed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (quality_card_id, signer_role) DO NOTHING`,
          [
            capability.id,
            '44444444-4444-4444-8444-444444444444',
            capability.requiredSlicePolicyVersion,
            'c'.repeat(64),
            signerId,
            role,
            capability.registeredAt,
          ],
        );
      }
      const allowedUseSlices = [
        {
          basisState: 'not_applicable',
          gradeBand: 'unclassified',
          imageQuality: 'clear',
          questionType: 'unclassified',
          riskLevel: 'unclassified',
          subject: 'unclassified',
        },
      ];
      await setupClient.query(
        `INSERT INTO metrics.capability_release_revisions
          (id, capability_key, kind, revision, stage, capability_version_id,
           fallback_version_id, rollout_basis_points, allowed_use_slices, predecessor_id,
           action, reason_code, changed_by, changed_at)
         VALUES ($1, $2, $3, 999999, 'general', $4, NULL, 10000, $5, NULL,
                 'advance', 'integration_test', 'quality-owner-1', $6)
         ON CONFLICT (id) DO UPDATE SET allowed_use_slices = EXCLUDED.allowed_use_slices`,
        [
          'ocr-release-v1',
          capability.capabilityKey,
          capability.kind,
          capability.id,
          JSON.stringify(allowedUseSlices),
          capability.registeredAt,
        ],
      );
      await setupClient.query(
        `UPDATE metrics.quality_control_epoch
         SET containment_epoch = 0, updated_at = $1
         WHERE singleton`,
        [capability.registeredAt],
      );
      await setupClient.query(
        `INSERT INTO metrics.capability_current_releases
          (capability_key, kind, primary_release_id, shadow_release_id,
           containment_epoch, updated_at)
         VALUES ($1, $2, $3, NULL, 0, $4)
         ON CONFLICT (capability_key, kind) DO UPDATE SET
           primary_release_id = EXCLUDED.primary_release_id,
           shadow_release_id = NULL,
           containment_epoch = 0,
           updated_at = EXCLUDED.updated_at`,
        [capability.capabilityKey, capability.kind, 'ocr-release-v1', capability.registeredAt],
      );
      await setupClient.query(
        `INSERT INTO metrics.authorization_decisions
          (id, capability_key, kind, family_space_hash, subject, grade_band, question_type,
           image_quality, risk_level, basis_state, rollout_bucket, containment_epoch,
           primary_release_id, primary_version_id, status, degraded_reason, issued_at)
         VALUES ($1, $2, $3, $4, 'unclassified', 'unclassified', 'unclassified',
                 'clear', 'unclassified', 'not_applicable', 321, 0, $5, $6,
                 'authorized', NULL, $7)
         ON CONFLICT (id) DO UPDATE SET
           containment_epoch = EXCLUDED.containment_epoch,
           primary_release_id = EXCLUDED.primary_release_id,
           primary_version_id = EXCLUDED.primary_version_id,
           status = EXCLUDED.status,
           degraded_reason = NULL`,
        [
          '22222222-2222-4222-8222-222222222222',
          capability.capabilityKey,
          capability.kind,
          createHash('sha256').update(familySpaceId).digest('hex'),
          'ocr-release-v1',
          capability.id,
          '2026-09-10T10:14:59.000Z',
        ],
      );
      await setupClient.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        familySpaceId,
      ]);
      await setupClient.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
        familySpaceId,
        '识别适配器测试',
      ]);
      await setupClient.query(
        `INSERT INTO learning.learning_profiles
          (id, family_space_id, display_name, grade, pin_hash)
         VALUES ($1, $2, $3, 3, $4)`,
        [learningProfileId, familySpaceId, '小禾', 'test-hash'],
      );
      await setupClient.query('COMMIT');
    } catch (error) {
      await setupClient.query('ROLLBACK');
      throw error;
    } finally {
      setupClient.release();
    }
    const store = new PostgresSubmissionStore(pool);
    const service = new SubmissionService({
      capabilityAuthorization,
      fileInspection: deterministicFileInspection,
      objectStore: new MemoryObjectStore(),
      rawAssetDeletions: store,
      recognition: deterministicRecognition,
      store,
    });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
    const pageId = randomUUID();
    const upload = await service.createUploadSession({
      familySpaceId,
      learningProfileId,
      pages: [
        {
          crop: null,
          fileName: '练习.jpg',
          height: 1_600,
          id: pageId,
          mimeType: 'image/jpeg',
          order: 0,
          rotation: 0,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          width: 1_200,
        },
      ],
    });
    await service.uploadPage({
      bytes,
      learningProfileId,
      pageId,
      token: upload.pages[0]!.uploadToken,
      uploadSessionId: upload.id,
    });
    const queued = await service.submit({ learningProfileId, uploadSessionId: upload.id });
    const recognized = await service.process(queued.id, learningProfileId);
    const reloaded = await service.getJob({ id: queued.id, learningProfileId });
    const confirmed = await service.confirm({
      edits: {},
      id: queued.id,
      learningProfileId,
    });

    expect(recognized.candidate).not.toBeNull();
    expect(reloaded.candidate).toMatchObject({
      adapterVersion: capability.adapter.version,
      authorization: {
        capabilityVersion: capability,
        containmentEpoch: 0,
        decisionId: '22222222-2222-4222-8222-222222222222',
      },
      finishedAt: recognized.candidate?.finishedAt,
    });
    expect(reloaded.candidate?.finishedAt).toBe(recognized.candidate?.finishedAt);
    expect(confirmed.completedContent).toMatchObject({
      sourceCandidateId: recognized.candidate?.id,
      sourceHash: recognized.candidate?.sourceHash,
    });
    await expect(
      service.getJob({ id: queued.id, learningProfileId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });

    const replayFamilySpaceId = randomUUID();
    const replayLearningProfileId = randomUUID();
    const replaySetup = await pool.connect();
    try {
      await replaySetup.query('BEGIN');
      await replaySetup.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        replayFamilySpaceId,
      ]);
      await replaySetup.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        replayLearningProfileId,
      ]);
      await replaySetup.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
        replayFamilySpaceId,
        '跨家庭重放测试',
      ]);
      await replaySetup.query(
        `INSERT INTO learning.learning_profiles
          (id, family_space_id, display_name, grade, pin_hash)
         VALUES ($1, $2, $3, 3, $4)`,
        [replayLearningProfileId, replayFamilySpaceId, '小林', 'test-hash'],
      );
      await replaySetup.query('COMMIT');
    } catch (error) {
      await replaySetup.query('ROLLBACK');
      throw error;
    } finally {
      replaySetup.release();
    }
    const replayPageId = randomUUID();
    const replayUpload = await service.createUploadSession({
      familySpaceId: replayFamilySpaceId,
      learningProfileId: replayLearningProfileId,
      pages: [
        {
          crop: null,
          fileName: '跨家庭重放.jpg',
          height: 1_600,
          id: replayPageId,
          mimeType: 'image/jpeg',
          order: 0,
          rotation: 0,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          width: 1_200,
        },
      ],
    });
    await service.uploadPage({
      bytes,
      learningProfileId: replayLearningProfileId,
      pageId: replayPageId,
      token: replayUpload.pages[0]!.uploadToken,
      uploadSessionId: replayUpload.id,
    });
    const replayQueued = await service.submit({
      learningProfileId: replayLearningProfileId,
      uploadSessionId: replayUpload.id,
    });
    await expect(service.process(replayQueued.id, replayLearningProfileId)).resolves.toMatchObject({
      candidate: null,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      retryable: true,
      status: 'unavailable',
    });

    const lateObjectStore = new MemoryObjectStore();
    const lateRecognition = {
      async recognize(input: Parameters<typeof deterministicRecognition.recognize>[0]) {
        await pool.query(
          `UPDATE metrics.quality_control_epoch
           SET containment_epoch = 1, updated_at = now()
           WHERE singleton`,
        );
        await pool.query(
          `UPDATE metrics.capability_current_releases
           SET containment_epoch = 1, updated_at = now()
           WHERE capability_key = $1 AND kind = $2`,
          [capability.capabilityKey, capability.kind],
        );
        return deterministicRecognition.recognize(input);
      },
    };
    const lateService = new SubmissionService({
      capabilityAuthorization,
      fileInspection: deterministicFileInspection,
      objectStore: lateObjectStore,
      rawAssetDeletions: store,
      recognition: lateRecognition,
      store,
    });
    const latePageId = randomUUID();
    const lateUpload = await lateService.createUploadSession({
      familySpaceId,
      learningProfileId,
      pages: [
        {
          crop: null,
          fileName: '迟到识别.jpg',
          height: 1_600,
          id: latePageId,
          mimeType: 'image/jpeg',
          order: 0,
          rotation: 0,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          width: 1_200,
        },
      ],
    });
    await lateService.uploadPage({
      bytes,
      learningProfileId,
      pageId: latePageId,
      token: lateUpload.pages[0]!.uploadToken,
      uploadSessionId: lateUpload.id,
    });
    const lateQueued = await lateService.submit({
      learningProfileId,
      uploadSessionId: lateUpload.id,
    });

    expect(await lateService.process(lateQueued.id, learningProfileId)).toMatchObject({
      candidate: null,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      retryable: true,
      status: 'unavailable',
    });
    expect(
      (await lateService.getJob({ id: lateQueued.id, learningProfileId })).candidate,
    ).toBeNull();
  });
});
