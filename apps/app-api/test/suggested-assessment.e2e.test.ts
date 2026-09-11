import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  MemorySuggestedAssessmentStore,
  SuggestedAssessmentService,
  type OpenAssessmentModelTask,
} from '@rhea/assessment';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import type { CapabilityVersion } from '@rhea/quality-control';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';
import { createLocalCapabilityAuthorization } from '../src/quality-control/local-capability-authorization.js';

const capability: CapabilityVersion = {
  adapter: { id: 'fixed-adapter', version: 'fixed-adapter-v1' },
  artifactHash: 'f'.repeat(64),
  capabilityKey: 'ai.open-assessment-suggestion',
  id: 'open-assessment-capability-v1',
  implementedBy: 'test-engineer',
  kind: 'ai',
  modelOrEngine: { id: 'fixed-model', version: 'fixed-model-v1' },
  policyVersion: 'child-learning-policy-v1',
  promptOrConfig: { kind: 'prompt', version: 'open-assessment-prompt-v1' },
  provider: { id: 'fixed-test-model', version: 'fixed-provider-contract-v1' },
  region: 'test-local',
  registeredAt: '2026-09-01T00:00:00.000Z',
  requiredSlicePolicyVersion: 'test-quality-policy-v1',
  templateVersion: 'open-assessment-template-v1',
};

describe('Suggested assessment HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => app?.close());

  it('derives trusted age and consent, then publishes only an adult-reviewed result', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({
      identityAssertion: 'suggested-assessment-guardian',
    });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '建议评价测试家庭',
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
      identityAssertion: 'suggested-assessment-guardian',
    });
    const consent = await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      granted: true,
      kind: 'ai_processing',
    });
    const basis = {
      contentHash: 'a'.repeat(64),
      kind: 'answer' as const,
      materialId: '00000000-0000-4000-8000-000000000010',
      selectionVersion: 2,
      sourceVersionId: '00000000-0000-4000-8000-000000000011',
      validityEpoch: 1,
      versionLabel: '教师答案第 2 版',
    };
    let receivedTask: OpenAssessmentModelTask | undefined;
    const scheduled: Array<{ id: string; learningProfileId: string }> = [];
    const suggestedAssessment = new SuggestedAssessmentService({
      basisReader: { getCurrentBasisReference: async () => basis },
      inputReader: {
        resolveOpenAssessmentInput: async () => ({
          question: {
            subject: 'mathematics',
            text: '请写出解题过程并说明理由。',
            versionId: 'question-v1',
          },
          requiresProfessionalReview: false,
          response: {
            text: '先算 6×7=42，因为每组有 7 个，一共有 6 组。',
            versionId: 'response-v1',
          },
          rubric: {
            ageBand: 'middle_primary',
            dimensions: [
              {
                description: '呈现与题意相符的方法。',
                key: 'method',
                label: '方法',
                required: true,
              },
              {
                description: '说明关键步骤为什么成立。',
                key: 'reasoning',
                label: '推理',
                required: true,
              },
            ],
            id: 'rhea-mathematics-process-middle-primary',
            name: '数学过程评分量规',
            source: {
              authority: 'rhea_professionally_reviewed',
              label: 'Rhea 学科组审核模板',
            },
            subject: 'mathematics',
            taskType: 'mathematics_process',
            version: '1.0.0',
          },
        }),
      },
      modelGateway: {
        async runStructured(task) {
          receivedTask = structuredClone(task);
          return {
            candidate: {
              confidence: 0.94,
              dimensions: [
                {
                  confidence: 0.93,
                  dimensionKey: 'method',
                  evidenceExcerpt: '先算 6×7=42',
                  improvementSuggestion: '把每一步和题意对应起来。',
                  observation: '作答写出了乘法步骤。',
                  state: 'demonstrated',
                },
                {
                  confidence: 0.9,
                  dimensionKey: 'reasoning',
                  evidenceExcerpt: '因为每组有 7 个，一共有 6 组',
                  improvementSuggestion: '再说明为什么使用乘法。',
                  observation: '作答说明了数量关系。',
                  state: 'partially_demonstrated',
                },
              ],
              improvementDimensionKey: 'reasoning',
              nextAction: '补充一句为什么这个数量关系要用乘法。',
              strengthEvidence: '作答同时写出了算式和数量关系。',
            },
            externalTraceId: 'http-trace-1',
            inputTokens: 100,
            outputTokens: 180,
            provider: 'fixed-test-model',
          };
        },
      },
      publicationGate: {
        authorize: async (input) => input.consentRevision === consent.revision,
      },
      qualityControl: createLocalCapabilityAuthorization(capability),
      store: new MemorySuggestedAssessmentStore(),
    });
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      suggestedAssessmentScheduler: {
        async schedule(request) {
          scheduled.push({ id: request.id, learningProfileId: request.learningProfileId });
        },
      },
      suggestedAssessmentService: suggestedAssessment,
    });
    await app.init();
    const baseUrl = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}`;
    const createdResponse = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: {
        ageBand: 'upper_primary',
        inputReference: {
          confirmedContentVersionId: 'content-v1',
          processingJobId: 'job-1',
          questionRegionId: 'question-1',
          responseRegionId: 'answer-1',
        },
        materialId: basis.materialId,
        taskType: 'mathematics_process',
      },
      url: `${baseUrl}/open-assessment-suggestions`,
    });
    expect(createdResponse.statusCode).toBe(202);
    const queued = createdResponse.json<{
      data: { id: string; stateRevision: number; status: string };
    }>().data;
    expect(queued.status).toBe('queued');
    expect(receivedTask).toBeUndefined();
    expect(scheduled).toEqual([{ id: queued.id, learningProfileId: profile.id }]);
    const pending = await suggestedAssessment.processSuggestion({
      learningProfileId: profile.id,
      suggestionId: queued.id,
    });
    expect(pending.status).toBe('pending_review');
    expect(receivedTask?.ageBand).toBe('middle_primary');

    const blocked = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/open-assessment-suggestions/${pending.id}/downstream-reference`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: 'DOWNSTREAM_INELIGIBLE' } });

    const decisions = [
      { action: 'accept', dimensionKey: 'method' },
      {
        action: 'modify',
        dimensionKey: 'reasoning',
        modification: {
          evidenceExcerpt: '因为每组有 7 个，一共有 6 组',
          improvementSuggestion: '再明确写出这是求 6 个 7 的总数。',
          observation: '作答说明了组数与每组数量。',
          state: 'partially_demonstrated',
        },
        reason: '依据原作答把观察描述得更准确',
      },
    ];
    const learnerReview = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: { decisions, expectedStateRevision: pending.stateRevision },
      url: `${baseUrl}/open-assessment-suggestions/${pending.id}/review`,
    });
    expect(learnerReview.statusCode).toBe(403);
    expect(learnerReview.json()).toMatchObject({
      error: { code: 'SUGGESTION_REVIEW_REQUIRES_ADULT' },
    });

    const adultReview = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: { decisions, expectedStateRevision: pending.stateRevision },
      url: `${baseUrl}/open-assessment-suggestions/${pending.id}/review`,
    });
    expect(adultReview.statusCode).toBe(201);
    expect(adultReview.json()).toMatchObject({
      data: {
        acceptedResult: {
          capabilityVersionId: capability.id,
          dimensions: [
            { decision: 'accepted', dimensionKey: 'method' },
            { decision: 'modified', dimensionKey: 'reasoning' },
          ],
        },
        status: 'accepted',
      },
    });

    const downstream = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/open-assessment-suggestions/${pending.id}/downstream-reference`,
    });
    expect(downstream.statusCode).toBe(200);
    expect(downstream.json()).toMatchObject({
      data: {
        assessmentId: pending.id,
        rubricVersion: '1.0.0',
        subject: 'mathematics',
      },
    });
  });
});
