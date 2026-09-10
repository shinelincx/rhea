import { describe, expect, it } from 'vitest';
import type {
  AuthorizationDecision,
  AuthorizationPhase,
  AuthorizationRevalidation,
  CapabilityVersion,
} from '@rhea/quality-control';

import {
  GeneratedLearningService,
  MemoryGeneratedLearningStore,
  type GeneratedLearningPackCandidate,
  type GenerationSourceSnapshot,
  type ModelGatewayPort,
} from '../src/index.js';

const actor = { id: 'profile-1', type: 'learner' as const };
const capability: CapabilityVersion = {
  adapter: { id: 'fixed-adapter', version: 'fixed-adapter-v1' },
  artifactHash: 'f'.repeat(64),
  capabilityKey: 'ai.generated-learning',
  id: 'learning-pack-capability-v1',
  implementedBy: 'engineer-1',
  kind: 'ai',
  modelOrEngine: { id: 'fixed-model', version: 'fixed-model-v1' },
  policyVersion: 'child-learning-policy-v1',
  promptOrConfig: { kind: 'prompt', version: 'learning-pack-prompt-v1' },
  provider: { id: 'fixed-test-model', version: 'fixed-provider-contract-v1' },
  region: 'test-local',
  registeredAt: '2026-09-01T00:00:00.000Z',
  requiredSlicePolicyVersion: 'quality-policy-v1',
  templateVersion: 'lesson-support-template-v1',
};
const basis = {
  contentHash: 'a'.repeat(64),
  kind: 'answer' as const,
  materialId: 'material-1',
  selectionVersion: 2,
  sourceVersionId: 'basis-version-private-2',
  validityEpoch: 1,
  versionLabel: '教师答案第 2 版',
};

function source(overrides: Partial<GenerationSourceSnapshot> = {}): GenerationSourceSnapshot {
  return {
    ageBand: 'middle_primary',
    basis,
    basisHasConflict: false,
    classificationRevision: 1,
    confirmedContentVersionId: 'content-1',
    coursePathName: '三年级上册',
    excerpts: [
      {
        kind: 'question',
        regionId: 'question-1',
        text: '学生小禾就读向阳小学，班级：三年级2班，学号：20260101，地址：上海市示例路1号，联系电话 138 0013 8000，身份证 310101 20100101 1234。计算 36 ÷ 4。',
      },
      { kind: 'answer', regionId: 'answer-1', text: '9' },
    ],
    knowledgePointNames: ['两位数除以一位数'],
    processingJobId: 'job-1',
    subject: 'mathematics',
    unitName: '除法',
    ...overrides,
  };
}

function candidate(
  overrides: Partial<GeneratedLearningPackCandidate> = {},
): GeneratedLearningPackCandidate {
  return {
    fullExplanation: {
      answer: '9',
      steps: ['把 36 看成 4 个相同的小组。', '36 ÷ 4 = 9，所以商是 9。'],
    },
    keyTerms: [{ sourceRegionIds: ['source-1'], term: '除法' }],
    methodHint: '想一想：4 乘几可以得到 36。',
    orientationHint: '先圈出总数 36 和每组数量 4。',
    quiz: [
      {
        explanationSteps: ['用乘法口诀检查：4 × 6 = 24。'],
        expectedAnswer: '6',
        gradingRule: { expected: '6', kind: 'numeric' },
        id: 'quiz-1',
        question: '24 ÷ 4 = ？',
      },
    ],
    summary: {
      keyPoints: ['除法可以帮助我们求平均分组的结果。', '可以用乘法口诀检查商。'],
      title: '用乘法口诀想除法',
    },
    supplementalNotes: [],
    variations: [
      {
        explanationSteps: ['想 4 × 8 = 32，所以 32 ÷ 4 = 8。'],
        expectedAnswer: '8',
        gradingRule: { expected: '8', kind: 'numeric' },
        id: 'variation-1',
        question: '32 ÷ 4 = ？',
      },
    ],
    ...overrides,
  };
}

function setup(
  input: {
    authorization?: {
      decision?: AuthorizationDecision;
      rejectAt?: AuthorizationPhase;
      throwAt?: AuthorizationPhase;
    };
    gateway?: ModelGatewayPort;
    gate?: { granted: boolean };
    initialBasis?: typeof basis;
  } = {},
) {
  const state = { basis: input.initialBasis ?? basis, classificationRevision: 1 };
  const gate = input.gate ?? { granted: true };
  const store = new MemoryGeneratedLearningStore();
  const calls: unknown[] = [];
  const authorizationPhases: AuthorizationPhase[] = [];
  const decision: AuthorizationDecision =
    input.authorization?.decision ??
    ({
      containmentEpoch: 4,
      decisionId: 'authorization-1',
      degradedReason: null,
      issuedAt: '2026-09-10T07:59:00.000Z',
      primary: { capabilityVersion: capability, rolloutStage: 'general' },
      rolloutBucket: 0,
      scope: {
        capabilityKey: 'ai.generated-learning',
        kind: 'ai',
        slice: {
          basisState: 'current',
          gradeBand: 'middle_primary',
          imageQuality: 'not_applicable',
          questionType: 'process',
          riskLevel: 'medium',
          subject: 'mathematics',
        },
      },
      shadow: null,
      status: 'authorized',
    } satisfies AuthorizationDecision);
  const gateway: ModelGatewayPort =
    input.gateway ??
    ({
      async runStructured(task) {
        calls.push(structuredClone(task));
        return {
          candidate: candidate(),
          externalTraceId: 'trace-1',
          inputTokens: 100,
          outputTokens: 200,
          provider: 'fixed-test-model',
        };
      },
    } satisfies ModelGatewayPort);
  const service = new GeneratedLearningService({
    basisReader: {
      getCurrentLearningContextReference: async () => ({
        basis: state.basis,
        classificationRevision: state.classificationRevision,
        confirmedContentVersionId: 'content-1',
        coursePathName: '三年级上册',
        knowledgePointNames: ['两位数除以一位数'],
        subject: 'mathematics',
        unitName: '除法',
      }),
    },
    clock: { now: new Date('2026-09-10T08:00:00.000Z') },
    modelGateway: gateway,
    publicationGate: { authorize: async () => gate.granted },
    qualityControl: {
      async authorizeCapability(requested) {
        return structuredClone({
          ...decision,
          scope: {
            capabilityKey: requested.capabilityKey,
            kind: requested.kind,
            slice: requested.slice,
          },
        });
      },
      async revalidateAuthorization(requested) {
        authorizationPhases.push(requested.phase);
        if (requested.phase === input.authorization?.throwAt) {
          throw new Error('QUALITY_CONTROL_UNAVAILABLE');
        }
        if (requested.phase === input.authorization?.rejectAt) {
          return {
            containmentEpoch: decision.containmentEpoch + 1,
            decisionId: decision.decisionId,
            reason: 'CAPABILITY_CONTAINED',
            status: 'rejected',
          } satisfies AuthorizationRevalidation;
        }
        return {
          capabilityVersion: capability,
          containmentEpoch: decision.containmentEpoch,
          decisionId: decision.decisionId,
          status: 'authorized',
        } satisfies AuthorizationRevalidation;
      },
    },
    store,
  });
  return { authorizationPhases, calls, gate, service, state, store };
}

async function request(service: GeneratedLearningService, idempotencyKey = 'request-1') {
  return service.requestContent({
    actor,
    consentRevision: 3,
    familySpaceId: 'family-1',
    idempotencyKey,
    learningProfileId: actor.id,
    materialId: basis.materialId,
    source: source(),
  });
}

describe('generated learning', () => {
  it('publishes a checked, traceable learning pack without exposing full help by default', async () => {
    const { calls, service } = setup();
    const queued = await request(service);

    expect(queued).toMatchObject({
      authorizationDecision: {
        containmentEpoch: 4,
        id: 'authorization-1',
      },
      capabilityVersion: {
        id: capability.id,
        promptOrConfig: capability.promptOrConfig,
        provider: capability.provider,
        templateVersion: capability.templateVersion,
      },
      contentState: 'unavailable',
      generatedContent: null,
      sourceVersion: {
        basisSelectionVersion: basis.selectionVersion,
        basisSourceVersionId: basis.sourceVersionId,
        classificationRevision: 1,
        confirmedContentVersionId: 'content-1',
      },
      status: 'queued',
    });
    expect((await request(service)).id).toBe(queued.id);

    const ready = await service.processRequest({
      learningProfileId: actor.id,
      requestId: queued.id,
    });

    expect(ready).toMatchObject({
      aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。',
      contentState: 'direct_learning',
      generatedContent: {
        fullExplanation: null,
        methodHint: null,
        orientationHint: null,
        quiz: [{ id: 'quiz-1' }],
        summary: { title: '用乘法口诀想除法' },
        variations: [{ id: 'variation-1' }],
      },
      revealedHintLevel: 0,
      status: 'ready',
    });
    expect(ready.generatedContent?.keyTerms).toEqual([
      { sourceRegionIds: ['question-1'], term: '除法' },
    ]);
    for (const privateValue of [
      'family-1',
      'profile-1',
      'material-1',
      'basis-version-private-2',
      '教师答案第 2 版',
      'content-1',
      'job-1',
      'question-1',
      'answer-1',
      '小禾',
      '向阳小学',
      '三年级2班',
      '20260101',
      '上海市示例路1号',
      '138 0013 8000',
      '310101 20100101 1234',
    ]) {
      expect(JSON.stringify(calls[0])).not.toContain(privateValue);
    }
    expect(calls[0]).toMatchObject({
      hintPolicy: 'orientation_then_method_then_full_explanation',
      maxQuizItems: 5,
      purpose: 'learning_pack',
      riskLevel: 'medium',
      sourceBasis: { kind: 'answer' },
      untrustedSourceExcerpts: [
        { kind: 'question', sourceRef: 'source-1' },
        { kind: 'answer', sourceRef: 'source-2' },
      ],
    });
  });

  it('reveals orientation, method, and full explanation in order and records every level', async () => {
    const { service, store } = setup();
    const queued = await request(service);
    const ready = await service.processRequest({
      learningProfileId: actor.id,
      requestId: queued.id,
    });

    const orientation = await service.revealNextHint({
      actor,
      expectedLevel: 0,
      learningProfileId: actor.id,
      requestId: ready.id,
    });
    expect(orientation.generatedContent).toMatchObject({
      fullExplanation: null,
      methodHint: null,
      orientationHint: candidate().orientationHint,
    });
    const method = await service.revealNextHint({
      actor,
      expectedLevel: 1,
      learningProfileId: actor.id,
      requestId: ready.id,
    });
    expect(method.generatedContent).toMatchObject({
      fullExplanation: null,
      methodHint: candidate().methodHint,
    });
    const full = await service.revealNextHint({
      actor,
      expectedLevel: 2,
      learningProfileId: actor.id,
      requestId: ready.id,
    });
    expect(full.generatedContent?.fullExplanation).toEqual(candidate().fullExplanation);
    expect(store.hintUsages.map(({ level }) => level)).toEqual([1, 2, 3]);
  });

  it('makes reveal retries idempotent and rejects clients ahead of the stored level', async () => {
    const { service, store } = setup();
    const queued = await request(service);
    const ready = await service.processRequest({
      learningProfileId: actor.id,
      requestId: queued.id,
    });

    const first = await service.revealNextHint({
      actor,
      expectedLevel: 0,
      learningProfileId: actor.id,
      requestId: ready.id,
    });
    const replay = await service.revealNextHint({
      actor,
      expectedLevel: 0,
      learningProfileId: actor.id,
      requestId: ready.id,
    });

    expect(first.revealedHintLevel).toBe(1);
    expect(replay.revealedHintLevel).toBe(1);
    expect(store.hintUsages.map(({ level }) => level)).toEqual([1]);
    await expect(
      service.revealNextHint({
        actor,
        expectedLevel: 2,
        learningProfileId: actor.id,
        requestId: ready.id,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('retries a failed generation check once and never accepts more than five quiz items', async () => {
    let attempt = 0;
    const gateway: ModelGatewayPort = {
      async runStructured() {
        attempt += 1;
        return {
          candidate:
            attempt === 1
              ? candidate({
                  quiz: Array.from({ length: 6 }, (_, index) => ({
                    ...candidate().quiz[0]!,
                    id: `quiz-${index + 1}`,
                  })),
                })
              : candidate(),
          externalTraceId: `trace-${attempt}`,
          inputTokens: 100,
          outputTokens: 200,
          provider: 'fixed-test-model',
        };
      },
    };
    const { service } = setup({ gateway });
    const queued = await request(service);

    await expect(
      service.processRequest({ learningProfileId: actor.id, requestId: queued.id }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(attempt).toBe(2);
  });

  it('fails closed for answer leakage, incorrect answers, or age-inappropriate output', async () => {
    const unsafeCandidates = [
      candidate({ summary: { keyPoints: ['答案是 9。'], title: '用乘法口诀想除法' } }),
      candidate({
        quiz: [
          {
            ...candidate().quiz[0]!,
            expectedAnswer: '7',
            gradingRule: { expected: '7', kind: 'numeric' },
          },
        ],
      }),
      candidate({
        summary: {
          keyPoints: ['这段说明超出了中年级儿童单次阅读能够可靠理解的句长。'.repeat(5)],
          title: '用乘法口诀想除法',
        },
      }),
      candidate({ methodHint: '   ' }),
      candidate({ quiz: [{ ...candidate().quiz[0]!, id: 'variation-1' }] }),
    ];
    for (const [index, unsafeCandidate] of unsafeCandidates.entries()) {
      const { service } = setup({
        gateway: {
          async runStructured() {
            return {
              candidate: unsafeCandidate,
              externalTraceId: 'unsafe',
              inputTokens: 1,
              outputTokens: 1,
              provider: 'fixed-test-model',
            };
          },
        },
      });
      const queued = await request(service, `unsafe-${index}`);
      await expect(
        service.processRequest({ learningProfileId: actor.id, requestId: queued.id }),
      ).resolves.toMatchObject({
        generatedContent: null,
        status: 'unavailable',
        unavailableReason: 'GENERATION_CHECK_FAILED',
      });
    }
  });

  it('requires confirmation for content whose answer cannot be verified deterministically', async () => {
    const unverified = candidate({
      quiz: [{ ...candidate().quiz[0]!, question: '24 个贴纸每 4 个一组，共几组？' }],
    });
    const { service } = setup({
      gateway: {
        async runStructured() {
          return {
            candidate: unverified,
            externalTraceId: 'unverified',
            inputTokens: 1,
            outputTokens: 1,
            provider: 'fixed-test-model',
          };
        },
      },
    });
    const queued = await request(service, 'unverified');

    await expect(
      service.processRequest({ learningProfileId: actor.id, requestId: queued.id }),
    ).resolves.toMatchObject({ contentState: 'confirmation_recommended', status: 'ready' });
  });

  it('binds idempotency to the full capability and source snapshot', async () => {
    const { service } = setup();
    await request(service, 'full-fingerprint');

    await expect(
      service.requestContent({
        actor,
        consentRevision: 3,
        familySpaceId: 'family-1',
        idempotencyKey: 'full-fingerprint',
        learningProfileId: actor.id,
        materialId: basis.materialId,
        source: source({ knowledgePointNames: ['另一知识点'] }),
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('fails closed after finite model failures and for a conflicting source', async () => {
    let attempts = 0;
    const { service } = setup({
      gateway: {
        async runStructured() {
          attempts += 1;
          throw new Error('provider unavailable');
        },
      },
    });
    const queued = await request(service);
    const unavailable = await service.processRequest({
      learningProfileId: actor.id,
      requestId: queued.id,
    });
    expect(unavailable).toMatchObject({
      contentState: 'unavailable',
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'MODEL_UNAVAILABLE',
    });
    expect(attempts).toBe(2);

    const conflictSetup = setup();
    const conflict = await conflictSetup.service.requestContent({
      actor,
      consentRevision: 3,
      familySpaceId: 'family-1',
      idempotencyKey: 'conflict',
      learningProfileId: actor.id,
      materialId: basis.materialId,
      source: source({ basisHasConflict: true }),
    });
    expect(conflict).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'SOURCE_UNAVAILABLE',
    });
    expect(conflictSetup.calls).toHaveLength(0);
  });

  it('discards late output after basis or consent changes and rejects stale reads', async () => {
    const sourceChanged = setup();
    const first = await request(sourceChanged.service);
    sourceChanged.state.basis = { ...basis, selectionVersion: 3 };
    expect(
      await sourceChanged.service.processRequest({
        learningProfileId: actor.id,
        requestId: first.id,
      }),
    ).toMatchObject({ unavailableReason: 'SOURCE_CHANGED' });
    expect(sourceChanged.calls).toHaveLength(0);

    const consentChanged = setup();
    const second = await request(consentChanged.service);
    consentChanged.gate.granted = false;
    expect(
      await consentChanged.service.processRequest({
        learningProfileId: actor.id,
        requestId: second.id,
      }),
    ).toMatchObject({ unavailableReason: 'CONSENT_WITHDRAWN' });
    expect(consentChanged.calls).toHaveLength(0);

    const staleRead = setup();
    const third = await request(staleRead.service);
    await staleRead.service.processRequest({ learningProfileId: actor.id, requestId: third.id });
    staleRead.state.basis = { ...basis, validityEpoch: 2 };
    expect(
      await staleRead.service.getRequest({ learningProfileId: actor.id, requestId: third.id }),
    ).toMatchObject({
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'SOURCE_CHANGED',
    });

    const reclassified = setup();
    const fourth = await request(reclassified.service, 'reclassified');
    await reclassified.service.processRequest({
      learningProfileId: actor.id,
      requestId: fourth.id,
    });
    reclassified.state.classificationRevision = 2;
    expect(
      await reclassified.service.getRequest({
        learningProfileId: actor.id,
        requestId: fourth.id,
      }),
    ).toMatchObject({
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'SOURCE_CHANGED',
    });
  });

  it('never publishes a model result when consent or the basis changes during generation', async () => {
    const consentGate = { granted: true };
    let consentSetup: ReturnType<typeof setup>;
    consentSetup = setup({
      gate: consentGate,
      gateway: {
        async runStructured() {
          consentGate.granted = false;
          return {
            candidate: candidate(),
            externalTraceId: 'late-consent-result',
            inputTokens: 100,
            outputTokens: 200,
            provider: 'fixed-test-model',
          };
        },
      },
    });
    const first = await request(consentSetup.service, 'late-consent');
    await expect(
      consentSetup.service.processRequest({
        learningProfileId: actor.id,
        requestId: first.id,
      }),
    ).resolves.toMatchObject({
      generatedContent: null,
      unavailableReason: 'CONSENT_WITHDRAWN',
    });

    let sourceSetup: ReturnType<typeof setup>;
    sourceSetup = setup({
      gateway: {
        async runStructured() {
          sourceSetup.state.basis = { ...basis, validityEpoch: 2 };
          return {
            candidate: candidate(),
            externalTraceId: 'late-source-result',
            inputTokens: 100,
            outputTokens: 200,
            provider: 'fixed-test-model',
          };
        },
      },
    });
    const second = await request(sourceSetup.service, 'late-source');
    await expect(
      sourceSetup.service.processRequest({
        learningProfileId: actor.id,
        requestId: second.id,
      }),
    ).resolves.toMatchObject({
      generatedContent: null,
      unavailableReason: 'SOURCE_CHANGED',
    });
  });

  it('creates a new immutable version for an explicit regeneration key', async () => {
    const { service, store } = setup();
    const first = await request(service, 'first');
    await service.processRequest({ learningProfileId: actor.id, requestId: first.id });
    const second = await request(service, 'second');
    await service.processRequest({ learningProfileId: actor.id, requestId: second.id });

    const storedFirst = await store.findById(first.id, actor.id);
    const storedSecond = await store.findById(second.id, actor.id);
    expect(storedSecond?.versions[0]).toMatchObject({
      predecessorId: storedFirst?.versions[0]?.id,
      revision: 2,
    });
  });

  it('records the exact authorized AI capability and revalidates every execution boundary', async () => {
    const { authorizationPhases, service, store } = setup();
    const queued = await request(service, 'governed-capability');
    const ready = await service.processRequest({
      learningProfileId: actor.id,
      requestId: queued.id,
    });
    const stored = await store.findById(ready.id, actor.id);

    expect(authorizationPhases).toEqual(['before_send', 'after_receive', 'before_publish']);
    expect(stored?.versions[0]).toMatchObject({
      authorization: {
        containmentEpoch: 4,
        decisionId: 'authorization-1',
      },
      capability: {
        adapter: capability.adapter,
        id: capability.id,
        modelOrEngine: capability.modelOrEngine,
        promptOrConfig: capability.promptOrConfig,
        provider: capability.provider,
      },
    });
    expect(stored?.modelRuns[0]).toMatchObject({
      authorizationDecisionId: 'authorization-1',
      capabilityVersionId: capability.id,
      finishedAt: '2026-09-10T08:00:00.000Z',
      modelOrEngineVersion: capability.modelOrEngine.version,
      promptOrConfigVersion: capability.promptOrConfig.version,
      provider: capability.provider.id,
      providerVersion: capability.provider.version,
      observedProvider: capability.provider.id,
    });
  });

  it('preserves the observed provider when a gateway routes outside the authorization', async () => {
    const { service, store } = setup({
      gateway: {
        async runStructured() {
          return {
            candidate: candidate(),
            externalTraceId: 'rogue-provider-trace',
            inputTokens: 100,
            outputTokens: 200,
            provider: 'unapproved-provider',
          };
        },
      },
    });
    const queued = await request(service, 'provider-mismatch');

    await expect(
      service.processRequest({ learningProfileId: actor.id, requestId: queued.id }),
    ).resolves.toMatchObject({
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'MODEL_UNAVAILABLE',
    });
    const stored = await store.findById(queued.id, actor.id);
    expect(stored?.modelRuns).toHaveLength(2);
    expect(stored?.modelRuns[0]).toMatchObject({
      externalTraceId: 'rogue-provider-trace',
      observedProvider: 'unapproved-provider',
      provider: capability.provider.id,
      succeeded: false,
    });
  });

  it('records one successful result and fails closed when after-receive revalidation errors', async () => {
    const { service, store } = setup({ authorization: { throwAt: 'after_receive' } });
    const queued = await request(service, 'revalidation-error');

    await expect(
      service.processRequest({ learningProfileId: actor.id, requestId: queued.id }),
    ).resolves.toMatchObject({
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'CAPABILITY_UNAVAILABLE',
    });
    const stored = await store.findById(queued.id, actor.id);
    expect(stored?.modelRuns).toHaveLength(1);
    expect(stored?.modelRuns[0]).toMatchObject({
      observedProvider: capability.provider.id,
      succeeded: true,
    });
  });

  it('returns a recoverable degraded state without calling the model when no capability is authorized', async () => {
    const degraded: AuthorizationDecision = {
      containmentEpoch: 7,
      decisionId: 'degraded-authorization',
      degradedReason: 'NO_SIGNED_CAPABILITY',
      issuedAt: '2026-09-10T07:59:00.000Z',
      primary: null,
      rolloutBucket: 42,
      scope: {
        capabilityKey: 'ai.generated-learning',
        kind: 'ai',
        slice: {
          basisState: 'current',
          gradeBand: 'middle_primary',
          imageQuality: 'not_applicable',
          questionType: 'process',
          riskLevel: 'medium',
          subject: 'mathematics',
        },
      },
      shadow: null,
      status: 'degraded',
    };
    const { calls, service } = setup({ authorization: { decision: degraded } });

    await expect(request(service, 'no-approved-capability')).resolves.toMatchObject({
      authorizationDecision: {
        containmentEpoch: 7,
        id: 'degraded-authorization',
      },
      capabilityVersion: null,
      degraded: {
        nextAction: 'retry_later',
        reason: 'NO_SIGNED_CAPABILITY',
        retryable: true,
      },
      status: 'unavailable',
      unavailableReason: 'CAPABILITY_UNAVAILABLE',
    });
    expect(calls).toHaveLength(0);
  });

  it('discards a response when containment activates after the provider returns', async () => {
    const { authorizationPhases, service, store } = setup({
      authorization: { rejectAt: 'after_receive' },
    });
    const queued = await request(service, 'contained-after-receive');

    await expect(
      service.processRequest({ learningProfileId: actor.id, requestId: queued.id }),
    ).resolves.toMatchObject({
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'CAPABILITY_CONTAINED',
    });
    expect(authorizationPhases).toEqual(['before_send', 'after_receive']);
    await expect(store.findById(queued.id, actor.id)).resolves.toMatchObject({ versions: [] });
  });
});
