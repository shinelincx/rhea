import { createHash } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import {
  GeneratedLearningService,
  MemoryGeneratedLearningStore,
  type GeneratedLearningCapability,
  type GeneratedLearningPackCandidate,
  type GeneratedLearningRequestView,
} from '@rhea/generated-learning';
import { LearningContentService, MemoryLearningContentStore } from '@rhea/learning-content';
import { FixedModelGateway } from '@rhea/model-gateway-adapter';
import {
  MemoryObjectStore,
  MemoryRawAssetDeletionLog,
  MemorySubmissionStore,
  SubmissionService,
  deterministicFileInspection,
  deterministicRecognition,
} from '@rhea/submission';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';
import { createLocalCapabilityAuthorization } from '../src/quality-control/local-capability-authorization.js';
import { LOCAL_RECOGNITION_CAPABILITY } from '../src/submission/create-local-submission.js';

const capability: GeneratedLearningCapability = {
  adapter: { id: 'fixed-adapter', version: 'fixed-adapter-v1' },
  artifactHash: 'f'.repeat(64),
  capabilityKey: 'ai.generated-learning',
  id: 'learning-pack-capability-v1',
  implementedBy: 'test-engineer',
  kind: 'ai',
  modelOrEngine: { id: 'fixed-model', version: 'fixed-model-v1' },
  policyVersion: 'child-learning-policy-v1',
  promptOrConfig: { kind: 'prompt', version: 'lesson-support-prompt-v1' },
  provider: { id: 'fixed-test-model', version: 'fixed-provider-contract-v1' },
  region: 'test-local',
  registeredAt: '2026-09-01T00:00:00.000Z',
  requiredSlicePolicyVersion: 'test-quality-policy-v1',
  templateVersion: 'lesson-support-template-v1',
};

const candidate: GeneratedLearningPackCandidate = {
  fullExplanation: {
    answer: '9',
    steps: ['先想 4 的乘法口诀。', '因为 4 × 9 = 36，所以 36 ÷ 4 = 9。'],
  },
  keyTerms: [{ sourceRegionIds: ['source-1'], term: '除法' }],
  methodHint: '想一想：4 乘几等于 36。',
  orientationHint: '先找出总数和每组的数量。',
  quiz: [
    {
      explanationSteps: ['因为 4 × 6 = 24，所以商是 6。'],
      expectedAnswer: '6',
      gradingRule: { expected: '6', kind: 'numeric' },
      id: 'quiz-1',
      question: '24 ÷ 4 = ？',
    },
  ],
  summary: { keyPoints: ['除法可以求平均分组的结果。'], title: '用乘法口诀想除法' },
  supplementalNotes: [],
  variations: [
    {
      explanationSteps: ['因为 4 × 8 = 32，所以商是 8。'],
      expectedAnswer: '8',
      gradingRule: { expected: '8', kind: 'numeric' },
      id: 'variation-1',
      question: '32 ÷ 4 = ？',
    },
  ],
};

describe('Generated learning HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => app?.close());

  it('uses authoritative source and age data, then reveals help one level at a time', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'generation-guardian' });
    if (guardian.actor.type !== 'guardian') throw new Error('guardian fixture is invalid');
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '生成学习测试家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 3,
      pin: '2468',
    });
    const device = await familyAccess.registerDevice({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      label: '测试设备',
    });
    const learner = await familyAccess.issueLearnerSession({
      deviceAccessToken: device.accessToken,
      learningProfileId: profile.id,
      pin: '2468',
    });
    await familyAccess.reverifyGuardian({
      accessToken: guardian.accessToken,
      identityAssertion: 'generation-guardian',
    });
    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      granted: true,
      kind: 'ai_processing',
    });

    const submissions = new SubmissionService({
      capabilityAuthorization: createLocalCapabilityAuthorization(LOCAL_RECOGNITION_CAPABILITY),
      fileInspection: deterministicFileInspection,
      objectStore: new MemoryObjectStore(),
      rawAssetDeletions: new MemoryRawAssetDeletionLog(),
      recognition: deterministicRecognition,
      store: new MemorySubmissionStore(),
    });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const upload = await submissions.createUploadSession({
      familySpaceId: family.id,
      learningProfileId: profile.id,
      pages: [
        {
          crop: null,
          fileName: 'division.jpg',
          height: 1_600,
          id: 'page-1',
          mimeType: 'image/jpeg',
          order: 0,
          rotation: 0,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          width: 1_200,
        },
      ],
    });
    await submissions.uploadPage({
      bytes,
      learningProfileId: profile.id,
      pageId: upload.pages[0]!.id,
      token: upload.pages[0]!.uploadToken,
      uploadSessionId: upload.id,
    });
    const submitted = await submissions.submit({
      learningProfileId: profile.id,
      uploadSessionId: upload.id,
    });
    await submissions.process(submitted.id, profile.id);
    const completed = await submissions.confirm({
      edits: { 'page-1:answer': '9' },
      id: submitted.id,
      learningProfileId: profile.id,
    });
    const learningContent = new LearningContentService({ store: new MemoryLearningContentStore() });
    const material = await learningContent.organizeConfirmedContent({
      actor: { id: profile.id, type: 'learner' },
      classification: {
        coursePathName: '三年级上册',
        knowledgePointNames: ['表内除法'],
        primaryKnowledgePointName: '表内除法',
        primarySubject: 'mathematics',
        relatedSubjects: [],
        unitName: '除法',
      },
      confirmedContentVersion: completed.completedContent!.version,
      confirmedContentVersionId: completed.completedContent!.id,
      familySpaceId: family.id,
      learningProfileId: profile.id,
      sourceHash: completed.completedContent!.sourceHash,
    });
    const model = new FixedModelGateway([{ candidate }]);
    const service = new GeneratedLearningService({
      basisReader: learningContent,
      modelGateway: model,
      publicationGate: {
        async authorize(input) {
          const consent = await familyAccess.getAiProcessingConsentSnapshotForPublication({
            familySpaceId: input.familySpaceId,
            learningProfileId: input.learningProfileId,
          });
          return consent?.status === 'granted' && consent.revision === input.consentRevision;
        },
      },
      qualityControl: createLocalCapabilityAuthorization(capability),
      store: new MemoryGeneratedLearningStore(),
    });
    const scheduled: GeneratedLearningRequestView[] = [];
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      generatedLearningConsentReader: familyAccess,
      generatedLearningScheduler: {
        async schedule(request) {
          scheduled.push(request);
        },
      },
      generatedLearningService: service,
      learningContentService: learningContent,
      submissionService: submissions,
    });
    await app.init();

    const baseUrl = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}`;
    const missingSource = await app.inject({
      headers: {
        authorization: `Bearer ${learner.accessToken}`,
        'idempotency-key': 'generation-request-missing-source',
      },
      method: 'POST',
      url: `${baseUrl}/learning-materials/${material.id}/generated-learning-requests`,
    });
    expect(missingSource.statusCode).toBe(422);
    expect(missingSource.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });

    const response = await app.inject({
      headers: {
        authorization: `Bearer ${learner.accessToken}`,
        'idempotency-key': 'generation-request-1',
      },
      method: 'POST',
      payload: { processingJobId: submitted.id },
      url: `${baseUrl}/learning-materials/${material.id}/generated-learning-requests`,
    });
    expect(response.statusCode).toBe(202);
    const queued = response.json<{ data: GeneratedLearningRequestView }>().data;
    expect(queued).toMatchObject({ status: 'queued', generatedContent: null });
    expect(scheduled).toHaveLength(1);

    await service.processRequest({ learningProfileId: profile.id, requestId: queued.id });
    const readyResponse = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/generated-learning-requests/${queued.id}`,
    });
    const ready = readyResponse.json<{ data: GeneratedLearningRequestView }>().data;
    expect(ready).toMatchObject({
      capabilityVersion: { id: capability.id },
      contentState: 'direct_learning',
      generatedContent: {
        fullExplanation: null,
        methodHint: null,
        orientationHint: null,
        summary: { title: '用乘法口诀想除法' },
      },
      sourceVersion: {
        classificationRevision: 1,
        confirmedContentVersionId: completed.completedContent!.id,
        versionLabel: 'confirmed-content-v1',
      },
      status: 'ready',
    });
    expect(model.tasks[0]).toMatchObject({ ageBand: 'middle_primary', subject: 'mathematics' });

    const missingExpectedLevel = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: {},
      url: `${baseUrl}/generated-learning-requests/${queued.id}/reveal-next-hint`,
    });
    expect(missingExpectedLevel.statusCode).toBe(400);

    for (const expectedLevel of [0, 1, 2] as const) {
      const hintResponse = await app.inject({
        headers: { authorization: `Bearer ${learner.accessToken}` },
        method: 'POST',
        payload: { expectedLevel },
        url: `${baseUrl}/generated-learning-requests/${queued.id}/reveal-next-hint`,
      });
      expect(hintResponse.json()).toMatchObject({
        data: { revealedHintLevel: expectedLevel + 1 },
      });
      if (expectedLevel === 0) {
        const replay = await app.inject({
          headers: { authorization: `Bearer ${learner.accessToken}` },
          method: 'POST',
          payload: { expectedLevel },
          url: `${baseUrl}/generated-learning-requests/${queued.id}/reveal-next-hint`,
        });
        expect(replay.json()).toMatchObject({ data: { revealedHintLevel: 1 } });
      }
    }
    const full = await service.getRequest({ learningProfileId: profile.id, requestId: queued.id });
    expect(full.generatedContent?.fullExplanation?.answer).toBe('9');

    await learningContent.correctClassification({
      actor: { id: guardian.actor.guardianId, type: 'guardian' },
      classification: {
        coursePathName: '三年级上册',
        knowledgePointNames: ['表内除法'],
        primaryKnowledgePointName: '表内除法',
        primarySubject: 'mathematics',
        relatedSubjects: [],
        unitName: '除法',
      },
      learningProfileId: profile.id,
      materialId: material.id,
      reason: '重新确认归类',
    });
    const staleAfterClassificationChange = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/generated-learning-requests/${queued.id}`,
    });
    expect(staleAfterClassificationChange.json()).toMatchObject({
      data: {
        generatedContent: null,
        status: 'unavailable',
        unavailableReason: 'SOURCE_CHANGED',
      },
    });

    const withUnresolvedSupplement = await learningContent.addSourceVersion({
      actor: { id: guardian.actor.guardianId, type: 'guardian' },
      contentHash: 'b'.repeat(64),
      kind: 'answer',
      label: '教师答案',
      learningProfileId: profile.id,
      materialId: material.id,
      versionLabel: '第 1 版',
    });
    const supplementalSource = withUnresolvedSupplement.sourceVersions.at(-1)!;
    await learningContent.selectCurrentBasis({
      actor: { id: guardian.actor.guardianId, type: 'guardian' },
      learningProfileId: profile.id,
      materialId: material.id,
      reason: '选择教师答案',
      sourceVersionId: supplementalSource.id,
    });
    const unavailableBasis = await app.inject({
      headers: {
        authorization: `Bearer ${learner.accessToken}`,
        'idempotency-key': 'generation-request-unresolved-basis',
      },
      method: 'POST',
      payload: { processingJobId: submitted.id },
      url: `${baseUrl}/learning-materials/${material.id}/generated-learning-requests`,
    });
    expect(unavailableBasis.json()).toMatchObject({
      data: {
        generatedContent: null,
        status: 'unavailable',
        unavailableReason: 'SOURCE_UNAVAILABLE',
      },
    });
    expect(scheduled).toHaveLength(1);

    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      granted: false,
      kind: 'ai_processing',
    });
    const withdrawn = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/generated-learning-requests/${queued.id}`,
    });
    expect(withdrawn.json()).toMatchObject({
      data: {
        generatedContent: null,
        status: 'unavailable',
        unavailableReason: 'CONSENT_WITHDRAWN',
      },
    });
  });
});
