import type { AuthorizationDecision, CapabilityVersion } from '@rhea/quality-control';
import { describe, expect, it } from 'vitest';

import {
  MemorySuggestedAssessmentStore,
  SuggestedAssessmentService,
  type OpenAssessmentModelCandidate,
  type OpenAssessmentModelTask,
  type OpenAssessmentTaskType,
  type ResolvedOpenAssessmentInput,
} from '../src/index.js';

const learner = { id: 'profile-1', type: 'learner' as const };
const familySpaceId = 'family-1';
const basis = {
  contentHash: 'a'.repeat(64),
  kind: 'answer' as const,
  materialId: 'material-1',
  selectionVersion: 2,
  sourceVersionId: 'basis-2',
  validityEpoch: 1,
  versionLabel: '教师答案第 2 版',
};
const capability: CapabilityVersion = {
  adapter: { id: 'fixed-adapter', version: 'fixed-adapter-v1' },
  artifactHash: 'f'.repeat(64),
  capabilityKey: 'ai.open-assessment-suggestion',
  id: 'open-assessment-capability-v1',
  implementedBy: 'engineer-1',
  kind: 'ai',
  modelOrEngine: { id: 'fixed-model', version: 'fixed-model-v1' },
  policyVersion: 'child-learning-policy-v1',
  promptOrConfig: { kind: 'prompt', version: 'open-assessment-prompt-v1' },
  provider: { id: 'fixed-test-model', version: 'fixed-provider-contract-v1' },
  region: 'test-local',
  registeredAt: '2026-09-01T00:00:00.000Z',
  requiredSlicePolicyVersion: 'quality-policy-v1',
  templateVersion: 'open-assessment-template-v1',
};

const samples: Array<{
  subject: ResolvedOpenAssessmentInput['question']['subject'];
  taskType: OpenAssessmentTaskType;
}> = [
  { subject: 'chinese', taskType: 'chinese_expression' },
  { subject: 'mathematics', taskType: 'mathematics_process' },
  { subject: 'english', taskType: 'english_expression' },
  { subject: 'science', taskType: 'science_inquiry' },
];

function candidate(dimensionKeys: string[]): OpenAssessmentModelCandidate {
  return {
    confidence: 0.92,
    dimensions: dimensionKeys.map((dimensionKey, index) => ({
      confidence: 0.9,
      dimensionKey,
      evidenceExcerpt: index === 0 ? '先观察叶片' : '记录颜色变化',
      improvementSuggestion: `补充${dimensionKey}对应的具体说明。`,
      observation: `作答呈现了${dimensionKey}相关证据。`,
      state: index === 0 ? 'demonstrated' : 'partially_demonstrated',
    })),
    improvementDimensionKey: dimensionKeys.at(-1)!,
    nextAction: '按建议补充一句可以从作答中核对的说明。',
    strengthEvidence: '作答先观察叶片，再记录颜色变化。',
  };
}

function setup(
  subject: ResolvedOpenAssessmentInput['question']['subject'],
  options: {
    gate?: { granted: boolean };
    modelError?: Error;
    modelProvider?: string;
    responseText?: string;
    requiresProfessionalReview?: boolean;
    tasks?: OpenAssessmentModelTask[];
    basisActors?: Array<{ id: string; type: 'guardian' | 'learner' | 'professional' }>;
    candidateValue?: OpenAssessmentModelCandidate;
    optionalDimension?: boolean;
    revalidationPhases?: string[];
  } = {},
) {
  const dimensionKeys = ['evidence', 'reasoning'];
  const decision: AuthorizationDecision = {
    containmentEpoch: 3,
    decisionId: `authorization-${subject}`,
    degradedReason: null,
    issuedAt: '2026-09-10T07:59:00.000Z',
    primary: { capabilityVersion: capability, rolloutStage: 'general' },
    rolloutBucket: 0,
    scope: {
      capabilityKey: capability.capabilityKey,
      kind: 'ai',
      slice: {
        basisState: 'current',
        gradeBand: 'middle_primary',
        imageQuality: 'not_applicable',
        questionType: subject === 'mathematics' ? 'process' : 'open_response',
        riskLevel: 'medium',
        subject,
      },
    },
    shadow: null,
    status: 'authorized',
  };
  const service = new SuggestedAssessmentService({
    basisReader: {
      async getCurrentBasisReference({ actor }) {
        options.basisActors?.push(structuredClone(actor));
        return basis;
      },
    },
    clock: { now: new Date('2026-09-10T08:00:00.000Z') },
    inputReader: {
      async resolveOpenAssessmentInput() {
        return {
          question: {
            subject,
            text: '请说明你的观察和理由。',
            versionId: `question-${subject}-v1`,
          },
          requiresProfessionalReview: options.requiresProfessionalReview ?? false,
          response: {
            text:
              options.responseText ?? '我先观察叶片，然后记录颜色变化，因为这样能比较前后差别。',
            versionId: `response-${subject}-v1`,
          },
          rubric: {
            ageBand: 'middle_primary',
            dimensions: dimensionKeys.map((key) => ({
              description: `${key}的可观察要求`,
              key,
              label: key === 'evidence' ? '证据' : '推理',
              required: !(options.optionalDimension && key === 'reasoning'),
            })),
            id: `rubric-${subject}`,
            name: `${subject}开放题评分量规`,
            source: {
              authority: 'rhea_professionally_reviewed',
              label: 'Rhea 学科组审核模板',
            },
            subject,
            taskType:
              samples.find((sample) => sample.subject === subject)?.taskType ??
              'chinese_expression',
            version: '1.0.0',
          },
        } satisfies ResolvedOpenAssessmentInput;
      },
    },
    modelGateway: {
      async runStructured(task) {
        if (options.modelError) throw options.modelError;
        options.tasks?.push(structuredClone(task));
        return {
          candidate: options.candidateValue ?? candidate(dimensionKeys),
          externalTraceId: `trace-${subject}`,
          inputTokens: 120,
          outputTokens: 240,
          provider: options.modelProvider ?? 'fixed-test-model',
        };
      },
    },
    publicationGate: { authorize: async () => options.gate?.granted ?? true },
    qualityControl: {
      authorizeCapability: async ({ slice }) => ({
        ...structuredClone(decision),
        scope: { ...structuredClone(decision.scope), slice: structuredClone(slice) },
      }),
      revalidateAuthorization: async ({ phase }) => {
        options.revalidationPhases?.push(phase);
        return {
          capabilityVersion: capability,
          containmentEpoch: decision.containmentEpoch,
          decisionId: decision.decisionId,
          status: 'authorized' as const,
        };
      },
    },
    store: new MemorySuggestedAssessmentStore(),
  });
  return service;
}

function request(taskType: OpenAssessmentTaskType = 'chinese_expression') {
  return {
    actor: learner,
    ageBand: 'middle_primary' as const,
    consentRevision: 1,
    familySpaceId,
    inputReference: {
      confirmedContentVersionId: 'content-1',
      processingJobId: 'job-1',
      questionRegionId: 'question-1',
      responseRegionId: 'answer-1',
    },
    learningProfileId: learner.id,
    materialId: basis.materialId,
    taskType,
  };
}

describe('建议评价', () => {
  it('先创建可恢复任务，再由 AI 工作进程生成待复核建议', async () => {
    const tasks: OpenAssessmentModelTask[] = [];
    const service = setup('chinese', { tasks });

    const queued = await service.requestSuggestion(request());

    expect(queued.status).toBe('queued');
    expect(tasks).toHaveLength(0);
    const processed = await service.processSuggestion({
      learningProfileId: learner.id,
      suggestionId: queued.id,
    });
    expect(processed.status).toBe('pending_review');
    expect(tasks).toHaveLength(1);
  });

  it.each(samples)('为 $subject 开放题生成待复核而非正式成绩的分维度建议', async ({ taskType }) => {
    const subject = samples.find((sample) => sample.taskType === taskType)!.subject;
    const service = setup(subject);

    const result = await service.suggest(request(taskType));

    expect(result).toMatchObject({
      aiDisclosure: 'AI 建议评价，不是官方成绩；需由有权成年人复核后才形成批改结果。',
      citations: {
        learningBasis: {
          sourceVersionId: basis.sourceVersionId,
          versionLabel: basis.versionLabel,
        },
        rubric: {
          sourceAuthority: 'rhea_professionally_reviewed',
          version: '1.0.0',
        },
      },
      status: 'pending_review',
      suggestion: {
        dimensions: [
          { dimensionKey: 'evidence', state: 'demonstrated' },
          { dimensionKey: 'reasoning', state: 'partially_demonstrated' },
        ],
      },
    });
    expect(result.suggestion?.dimensions).toHaveLength(2);
    await expect(
      service.getAcceptedResultReference({
        actor: learner,
        learningProfileId: learner.id,
        suggestionId: result.id,
      }),
    ).rejects.toMatchObject({ code: 'DOWNSTREAM_INELIGIBLE' });
  });

  it.each([
    {
      candidateValue: candidate(['evidence', 'reasoning']),
      expectedNeeds: ['适用评分量规'],
      expectedReason: 'RUBRIC_REQUIRED',
      rubricAvailable: false,
    },
    {
      candidateValue: { ...candidate(['evidence', 'reasoning']), confidence: 0.61 },
      expectedNeeds: ['更清晰或更完整的作答证据', '人工复核'],
      expectedReason: 'LOW_CONFIDENCE',
      rubricAvailable: true,
    },
  ])(
    '在 $expectedReason 时不评价并说明需要的补充',
    async ({ candidateValue, expectedNeeds, expectedReason, rubricAvailable }) => {
      let modelCalls = 0;
      const store = new MemorySuggestedAssessmentStore();
      const rubric: NonNullable<ResolvedOpenAssessmentInput['rubric']> = {
        ageBand: 'middle_primary',
        dimensions: ['evidence', 'reasoning'].map((key) => ({
          description: `${key}要求`,
          key,
          label: key,
          required: true,
        })),
        id: 'rubric-chinese',
        name: '语文表达评分量规',
        source: {
          authority: 'rhea_professionally_reviewed',
          label: 'Rhea 学科组审核模板',
        },
        subject: 'chinese',
        taskType: 'chinese_expression',
        version: '1.0.0',
      };
      const service = new SuggestedAssessmentService({
        basisReader: { getCurrentBasisReference: async () => basis },
        inputReader: {
          resolveOpenAssessmentInput: async () => ({
            question: {
              subject: 'chinese',
              text: '请结合内容说明理由。',
              versionId: 'question-v1',
            },
            requiresProfessionalReview: false,
            response: {
              text: '我先观察叶片，然后记录颜色变化。',
              versionId: 'response-v1',
            },
            rubric: rubricAvailable ? rubric : null,
          }),
        },
        modelGateway: {
          async runStructured() {
            modelCalls += 1;
            return {
              candidate: candidateValue,
              externalTraceId: 'trace-low-confidence',
              inputTokens: 100,
              outputTokens: 150,
              provider: 'fixed-test-model',
            };
          },
        },
        publicationGate: { authorize: async () => true },
        qualityControl: {
          authorizeCapability: async ({ capabilityKey, kind, slice }) => ({
            containmentEpoch: 1,
            decisionId: 'authorization-degrade-test',
            degradedReason: null,
            issuedAt: '2026-09-10T08:00:00.000Z',
            primary: { capabilityVersion: capability, rolloutStage: 'general' },
            rolloutBucket: 0,
            scope: { capabilityKey, kind, slice },
            shadow: null,
            status: 'authorized',
          }),
          revalidateAuthorization: async () => ({
            capabilityVersion: capability,
            containmentEpoch: 1,
            decisionId: 'authorization-degrade-test',
            status: 'authorized',
          }),
        },
        store,
      });

      const result = await service.suggest(request());

      expect(result).toMatchObject({
        status: 'unavailable',
        suggestion: null,
        unavailable: {
          needs: expectedNeeds,
          reason: expectedReason,
        },
        unavailableReason: expectedReason,
      });
      expect(modelCalls).toBe(rubricAvailable ? 1 : 0);
    },
  );

  it('仅允许有权成年人逐维接受或修改，并完整保留原建议与能力版本', async () => {
    const revalidationPhases: string[] = [];
    const service = setup('chinese', { revalidationPhases });
    const pending = await service.suggest(request());
    const decisions = [
      { action: 'accept' as const, dimensionKey: 'evidence' },
      {
        action: 'modify' as const,
        dimensionKey: 'reasoning',
        modification: {
          evidenceExcerpt: '因为这样能比较前后差别',
          improvementSuggestion: '再写清楚“前后”分别指什么。',
          observation: '作答给出了比较前后差别的理由，但比较对象还可以更具体。',
          state: 'partially_demonstrated' as const,
        },
        reason: '监护人依据原作答补充更准确的观察描述',
      },
    ];

    await expect(
      service.review({
        decisions,
        expectedStateRevision: pending.stateRevision,
        learningProfileId: learner.id,
        reviewer: learner,
        suggestionId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'SUGGESTION_REVIEW_REQUIRES_ADULT' });

    const accepted = await service.review({
      decisions,
      expectedStateRevision: pending.stateRevision,
      learningProfileId: learner.id,
      reviewer: { id: 'guardian-1', type: 'guardian' },
      suggestionId: pending.id,
    });

    expect(accepted).toMatchObject({
      acceptedResult: {
        capabilityVersionId: capability.id,
        dimensions: [
          { decision: 'accepted', dimensionKey: 'evidence', state: 'demonstrated' },
          {
            decision: 'modified',
            dimensionKey: 'reasoning',
            observation: '作答给出了比较前后差别的理由，但比较对象还可以更具体。',
          },
        ],
        rubricVersion: '1.0.0',
      },
      review: {
        reviewedAt: '2026-09-10T08:00:00.000Z',
        reviewedBy: { id: 'guardian-1', type: 'guardian' },
      },
      stateRevision: 4,
      status: 'accepted',
    });
    expect(accepted.suggestion).toEqual(pending.suggestion);
    expect(revalidationPhases).toEqual(['before_send', 'after_receive', 'before_publish']);
    await expect(
      service.getAcceptedResultReference({
        actor: learner,
        learningProfileId: learner.id,
        suggestionId: pending.id,
      }),
    ).resolves.toMatchObject({
      assessmentId: pending.id,
      basisSourceVersionId: basis.sourceVersionId,
      rubricVersion: '1.0.0',
      subject: 'chinese',
    });
  });

  it('将高影响或依据冲突评价锁定到专业复核，并允许专业复核者逐维拒绝', async () => {
    const basisActors: Array<{ id: string; type: 'guardian' | 'learner' | 'professional' }> = [];
    const service = setup('science', { basisActors, requiresProfessionalReview: true });
    const pending = await service.suggest(request('science_inquiry'));
    const decisions = [
      { action: 'accept' as const, dimensionKey: 'evidence' },
      {
        action: 'reject' as const,
        dimensionKey: 'reasoning',
        reason: '现有量规没有覆盖这个合理解释，需要补充依据后重新评价',
      },
    ];

    await expect(
      service.review({
        decisions,
        expectedStateRevision: pending.stateRevision,
        learningProfileId: learner.id,
        reviewer: { id: 'guardian-1', type: 'guardian' },
        suggestionId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'PROFESSIONAL_REVIEW_REQUIRED' });

    const rejected = await service.review({
      decisions,
      expectedStateRevision: pending.stateRevision,
      learningProfileId: learner.id,
      reviewer: { id: 'professional-1', type: 'professional' },
      suggestionId: pending.id,
    });

    expect(rejected).toMatchObject({
      acceptedResult: null,
      review: {
        decisions: [
          { action: 'accept', dimensionKey: 'evidence' },
          { action: 'reject', dimensionKey: 'reasoning' },
        ],
        reviewedBy: { id: 'professional-1', type: 'professional' },
      },
      status: 'rejected',
    });
    expect(rejected.suggestion).toEqual(pending.suggestion);
    expect(basisActors).toContainEqual({ id: 'professional-1', type: 'professional' });
    await expect(
      service.getAcceptedResultReference({
        actor: learner,
        learningProfileId: learner.id,
        suggestionId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'DOWNSTREAM_INELIGIBLE' });
  });

  it('模型不可用时明确不评价，且不会伪造建议内容', async () => {
    const service = setup('english', { modelError: new Error('provider timeout') });

    await expect(service.suggest(request('english_expression'))).resolves.toMatchObject({
      status: 'unavailable',
      suggestion: null,
      unavailable: {
        needs: ['稍后重试或人工复核'],
        reason: 'MODEL_UNAVAILABLE',
      },
    });
  });

  it('拒绝未授权提供方替换已授权的模型能力', async () => {
    const service = setup('english', { modelProvider: 'unapproved-provider' });

    await expect(service.suggest(request('english_expression'))).resolves.toMatchObject({
      status: 'unavailable',
      suggestion: null,
      unavailableReason: 'MODEL_UNAVAILABLE',
    });
  });

  it('发送到模型前移除作答中的儿童直接身份信息', async () => {
    const tasks: OpenAssessmentModelTask[] = [];
    const service = setup('chinese', {
      responseText:
        '姓名：小禾，学校：向阳小学，电话 13800138000。我先观察叶片，然后记录颜色变化。',
      tasks,
    });

    await service.suggest(request('chinese_expression'));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.response.text).not.toContain('小禾');
    expect(tasks[0]?.response.text).not.toContain('向阳小学');
    expect(tasks[0]?.response.text).not.toContain('13800138000');
    expect(tasks[0]?.response.text).toContain('我先观察叶片');
  });

  it('AI 处理同意在待复核期间撤回后不能形成批改结果', async () => {
    const gate = { granted: true };
    const service = setup('mathematics', { gate });
    const pending = await service.suggest(request('mathematics_process'));
    gate.granted = false;

    await expect(
      service.review({
        decisions: pending.suggestion!.dimensions.map(({ dimensionKey }) => ({
          action: 'accept' as const,
          dimensionKey,
        })),
        expectedStateRevision: pending.stateRevision,
        learningProfileId: learner.id,
        reviewer: { id: 'guardian-1', type: 'guardian' },
        suggestionId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'AI_PROCESSING_CONSENT_REQUIRED' });
  });

  it('安全敏感内容进入专业复核，普通监护人不能直接接受', async () => {
    const service = setup('chinese', {
      responseText: '我先观察叶片，然后记录颜色变化。题目里还提到了自残。',
    });
    const pending = await service.suggest(request());

    expect(pending.requiresProfessionalReview).toBe(true);
    await expect(
      service.review({
        decisions: pending.suggestion!.dimensions.map(({ dimensionKey }) => ({
          action: 'accept' as const,
          dimensionKey,
        })),
        expectedStateRevision: pending.stateRevision,
        learningProfileId: learner.id,
        reviewer: { id: 'guardian-1', type: 'guardian' },
        suggestionId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'PROFESSIONAL_REVIEW_REQUIRED' });
  });

  it('量规未覆盖到足够证据时保留建议但升级为专业复核', async () => {
    const candidateValue = candidate(['evidence', 'reasoning']);
    candidateValue.dimensions[1]!.state = 'insufficient_evidence';
    const service = setup('chinese', { candidateValue });

    await expect(service.suggest(request())).resolves.toMatchObject({
      requiresProfessionalReview: true,
      status: 'pending_review',
    });
  });

  it('只要求完成量规中的必需维度，可选维度不会阻断接受', async () => {
    const service = setup('chinese', { optionalDimension: true });
    const pending = await service.suggest(request());
    const accepted = await service.review({
      decisions: [{ action: 'accept', dimensionKey: 'evidence' }],
      expectedStateRevision: pending.stateRevision,
      learningProfileId: learner.id,
      reviewer: { id: 'guardian-1', type: 'guardian' },
      suggestionId: pending.id,
    });

    expect(accepted.acceptedResult?.dimensions).toEqual([
      expect.objectContaining({ dimensionKey: 'evidence' }),
    ]);
  });
});
