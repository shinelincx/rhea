import { describe, expect, it } from 'vitest';

import type { AcceptedObjectiveAssessmentSnapshot } from '@rhea/assessment';
import type { CapabilityVersion } from '@rhea/quality-control';

import {
  LearningProgressService,
  MemoryLearningProgressStore,
  MemoryReviewCardStore,
  ReviewCardService,
  type AcceptedObjectiveAssessmentReader,
  type ReviewCardCandidate,
  type ReviewCardQualityControlPort,
} from '../src/index.js';

const learner = { id: 'profile-1', type: 'learner' } as const;
const basis = {
  contentHash: 'a'.repeat(64),
  kind: 'answer' as const,
  materialId: 'material-1',
  selectionVersion: 1,
  sourceVersionId: 'basis-1',
  validityEpoch: 1,
  versionLabel: 'teacher-answer-v1',
};
const capability: CapabilityVersion = {
  adapter: { id: 'review-card-adapter', version: '1' },
  artifactHash: 'd'.repeat(64),
  capabilityKey: 'ai.review-card',
  id: 'review-card-capability-1',
  implementedBy: 'review-card-model',
  kind: 'ai',
  modelOrEngine: { id: 'fixed', version: '1' },
  policyVersion: 'policy-1',
  promptOrConfig: { kind: 'prompt', version: 'review-card-v1' },
  provider: { id: 'fixed-provider', version: '1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-01T00:00:00.000Z',
  requiredSlicePolicyVersion: 'slice-policy-1',
  templateVersion: '1',
};

function snapshot(
  overrides: Partial<AcceptedObjectiveAssessmentSnapshot> = {},
): AcceptedObjectiveAssessmentSnapshot {
  return {
    assessmentId: 'assessment-1',
    assessmentVersionId: 'assessment-version-1',
    basis,
    correctBasis: { expectedDisplay: '42', gradingRuleVersionId: 'rule-1' },
    familySpaceId: 'family-1',
    firstIncorrectAt: '2026-09-10T08:00:00.000Z',
    inputReference: {
      confirmedContentVersionId: 'content-1',
      processingJobId: 'job-1',
      questionRegionId: 'question-1',
      responseRegionId: 'response-1',
    },
    learningProfileId: 'profile-1',
    materialId: 'material-1',
    outcome: 'incorrect',
    question: {
      contentHash: 'b'.repeat(64),
      subject: 'mathematics',
      text: '40 + 2 等于多少？',
      versionId: 'question-version-1',
    },
    response: { contentHash: 'c'.repeat(64), text: '41', versionId: 'response-version-1' },
    ...overrides,
  };
}

const validCandidate: ReviewCardCandidate = {
  explanationSteps: ['先算十位和个位：30 + 12 = 42。'],
  expectedAnswer: '42',
  gradingRule: { expected: '42', kind: 'numeric' },
  keyChanges: ['把两个加数改成 30 和 12', '保留两位数加法知识点'],
  methodHint: '把两个加数按数位对齐后相加。',
  orientationHint: '想一想十位和个位分别怎样合并。',
  question: '30 + 12 等于多少？',
};

function qualityControl(contained: { value: boolean }): ReviewCardQualityControlPort {
  const decision = {
    containmentEpoch: 1,
    decisionId: 'decision-1',
    degradedReason: null,
    issuedAt: '2026-09-11T00:00:00.000Z',
    primary: { capabilityVersion: capability, rolloutStage: 'general' as const },
    rolloutBucket: 1,
    scope: {
      capabilityKey: 'ai.review-card',
      kind: 'ai' as const,
      slice: {
        basisState: 'current' as const,
        gradeBand: 'middle_primary' as const,
        imageQuality: 'not_applicable' as const,
        questionType: 'objective' as const,
        riskLevel: 'medium' as const,
        subject: 'mathematics' as const,
      },
    },
    shadow: null,
    status: 'authorized' as const,
  };
  return {
    async authorizeCapability() {
      return structuredClone(decision);
    },
    async revalidateAuthorization(input) {
      return contained.value
        ? {
            containmentEpoch: 2,
            decisionId: input.decisionId,
            reason: 'CAPABILITY_CONTAINED' as const,
            status: 'rejected' as const,
          }
        : {
            capabilityVersion: structuredClone(capability),
            containmentEpoch: 1,
            decisionId: input.decisionId,
            status: 'authorized' as const,
          };
    },
  };
}

async function fixture(
  options: {
    candidate?: ReviewCardCandidate;
    classified?: boolean;
    publicationGate?: (call: number) => boolean;
  } = {},
) {
  let current = snapshot();
  let now = new Date('2026-09-11T09:00:00.000Z');
  let publicationGateCalls = 0;
  const wrongItemStore = new MemoryLearningProgressStore();
  const reviewCardStore = new MemoryReviewCardStore();
  const contained = { value: false };
  const reader: AcceptedObjectiveAssessmentReader = {
    async evaluateImmediateCorrection(input) {
      return {
        assessmentId: current.assessmentId,
        assessmentVersionId: current.assessmentVersionId,
        basis: current.basis,
        evaluatedResponse: input.responseText,
        expectedDisplay: current.correctBasis.expectedDisplay,
        normalizedResponse: input.responseText,
        outcome:
          input.responseText === current.correctBasis.expectedDisplay ? 'correct' : 'incorrect',
      };
    },
    async getAcceptedObjectiveAssessmentSnapshot() {
      return structuredClone(current);
    },
  };
  const progress = new LearningProgressService({
    assessmentReader: reader,
    clock: {
      get now() {
        return now;
      },
    },
    learningContextReader: {
      async getCurrentLearningContextReference() {
        return {
          basis,
          classificationRevision: 1,
          confirmedContentVersionId: 'content-1',
          coursePathName: null,
          knowledgePointNames: options.classified === false ? [] : ['两位数加法'],
          primaryKnowledgePointName: options.classified === false ? null : '两位数加法',
          subject: 'mathematics' as const,
          unitName: '加法',
        };
      },
    },
    store: wrongItemStore,
  });
  const item = await progress.captureAcceptedError({
    actor: learner,
    assessmentId: current.assessmentId,
    learningProfileId: current.learningProfileId,
  });
  const tasks: unknown[] = [];
  const service = new ReviewCardService({
    assessmentReader: reader,
    clock: {
      get now() {
        return now;
      },
    },
    modelGateway: {
      async runStructured(task) {
        tasks.push(structuredClone(task));
        return {
          candidate: structuredClone(options.candidate ?? validCandidate),
          externalTraceId: 'trace-1',
          inputTokens: 100,
          outputTokens: 120,
          provider: 'fixed-provider',
        };
      },
    },
    publicationGate: {
      async authorize() {
        publicationGateCalls += 1;
        return options.publicationGate?.(publicationGateCalls) ?? true;
      },
    },
    qualityControl: qualityControl(contained),
    reviewCardStore,
    wrongItemStore,
  });
  return {
    contained,
    item: item!,
    service,
    setCurrent(value: AcceptedObjectiveAssessmentSnapshot) {
      current = value;
    },
    setNow(value: string) {
      now = new Date(value);
    },
    tasks,
  };
}

describe('ReviewCardService', () => {
  it('publishes a checked AI rewrite with a collapsed but traceable original', async () => {
    const { item, service, tasks } = await fixture();
    const request = await service.requestReviewCard({
      actor: learner,
      ageBand: 'middle_primary',
      consentRevision: 2,
      familySpaceId: 'family-1',
      idempotencyKey: 'request-1',
      learningProfileId: 'profile-1',
      wrongItemId: item.id,
    });
    await expect(
      service.requestReviewCard({
        actor: learner,
        ageBand: 'middle_primary',
        consentRevision: 2,
        familySpaceId: 'family-1',
        idempotencyKey: 'request-1',
        learningProfileId: 'profile-1',
        wrongItemId: item.id,
      }),
    ).resolves.toMatchObject({ id: request.id });
    await expect(
      service.requestReviewCard({
        actor: learner,
        ageBand: 'middle_primary',
        consentRevision: 1,
        familySpaceId: 'family-1',
        idempotencyKey: 'request-1',
        learningProfileId: 'profile-1',
        wrongItemId: item.id,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    const ready = await service.processRequest({
      learningProfileId: 'profile-1',
      requestId: request.id,
    });

    expect(ready).toMatchObject({
      aiDisclosure: expect.stringContaining('AI 重新生成'),
      card: {
        aiGenerated: true,
        content: {
          keyChanges: expect.arrayContaining(['把两个加数改成 30 和 12']),
          knowledgePointName: '两位数加法',
          question: '30 + 12 等于多少？',
        },
        original: {
          collapsedByDefault: true,
          question: '40 + 2 等于多少？',
          relation: 'generated_from_wrong_item',
          wrongItemId: item.id,
        },
        schedule: { intervalDays: 1, stepIndex: 0 },
      },
      status: 'ready',
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      purpose: 'review_card',
      constraints: {
        doNotCopyOriginalQuestion: true,
        rewriteStrategy: 'change_math_quantities_or_context_preserve_answer',
      },
    });
  });

  it('rejects pending classification and fails closed when the model copies the original', async () => {
    const pending = await fixture({ classified: false });
    await expect(
      pending.service.requestReviewCard({
        actor: learner,
        ageBand: 'middle_primary',
        consentRevision: 1,
        familySpaceId: 'family-1',
        idempotencyKey: 'pending',
        learningProfileId: 'profile-1',
        wrongItemId: pending.item.id,
      }),
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_INVALID' });

    const copied = await fixture({
      candidate: { ...validCandidate, question: '请回答：40＋2 等于多少！' },
    });
    const requested = await copied.service.requestReviewCard({
      actor: learner,
      ageBand: 'middle_primary',
      consentRevision: 1,
      familySpaceId: 'family-1',
      idempotencyKey: 'copied',
      learningProfileId: 'profile-1',
      wrongItemId: copied.item.id,
    });
    await expect(
      copied.service.processRequest({ learningProfileId: 'profile-1', requestId: requested.id }),
    ).resolves.toMatchObject({
      card: null,
      status: 'unavailable',
      unavailableReason: 'GENERATION_CHECK_FAILED',
    });
    expect(copied.tasks).toHaveLength(2);
  });

  it('rejects a model grading rule that broadens the trusted correct answer', async () => {
    const broadened = await fixture({
      candidate: {
        ...validCandidate,
        gradingRule: {
          acceptedAnswers: ['42', '任何答案'],
          caseSensitive: false,
          collapseWhitespace: true,
          kind: 'accepted_text',
        },
      },
    });
    const request = await broadened.service.requestReviewCard({
      actor: learner,
      ageBand: 'middle_primary',
      consentRevision: 1,
      familySpaceId: 'family-1',
      idempotencyKey: 'broad-rule',
      learningProfileId: 'profile-1',
      wrongItemId: broadened.item.id,
    });

    await expect(
      broadened.service.processRequest({
        learningProfileId: 'profile-1',
        requestId: request.id,
      }),
    ).resolves.toMatchObject({
      card: null,
      status: 'unavailable',
      unavailableReason: 'GENERATION_CHECK_FAILED',
    });
    expect(broadened.tasks).toHaveLength(2);
  });

  it('fails closed when consent changes after model generation but before publication', async () => {
    const withdrawn = await fixture({ publicationGate: (call) => call < 3 });
    const request = await withdrawn.service.requestReviewCard({
      actor: learner,
      ageBand: 'middle_primary',
      consentRevision: 1,
      familySpaceId: 'family-1',
      idempotencyKey: 'consent-race',
      learningProfileId: 'profile-1',
      wrongItemId: withdrawn.item.id,
    });

    await expect(
      withdrawn.service.processRequest({
        learningProfileId: 'profile-1',
        requestId: request.id,
      }),
    ).resolves.toMatchObject({
      card: null,
      status: 'unavailable',
      unavailableReason: 'CONSENT_WITHDRAWN',
    });
  });

  it('uses a maximum-five due-card session and adjusts the 1/3/7/14/30 schedule from evidence only', async () => {
    const { item, service, setNow } = await fixture();
    const request = await service.requestReviewCard({
      actor: learner,
      ageBand: 'middle_primary',
      consentRevision: 1,
      familySpaceId: 'family-1',
      idempotencyKey: 'schedule',
      learningProfileId: 'profile-1',
      wrongItemId: item.id,
    });
    await service.processRequest({ learningProfileId: 'profile-1', requestId: request.id });
    setNow('2026-09-12T10:00:00.000Z');
    const session = await service.createShortReviewSession({
      actor: learner,
      learningProfileId: 'profile-1',
    });
    expect(session.cards).toHaveLength(1);

    const first = await service.submitAttempt({
      actor: learner,
      cardId: session.cards[0]!.id,
      hintLevel: 0,
      idempotencyKey: 'attempt-1',
      learningProfileId: 'profile-1',
      perceivedDifficulty: 'hard',
      responseText: '42',
      sessionId: session.id,
    });
    expect(first.feedback).toMatchObject({ nextIntervalDays: 3, outcome: 'correct' });
    expect(first.attempt.perceivedDifficulty).toBe('hard');
    await expect(
      service.submitAttempt({
        actor: learner,
        cardId: session.cards[0]!.id,
        hintLevel: 0,
        idempotencyKey: 'attempt-1',
        learningProfileId: 'profile-1',
        perceivedDifficulty: 'hard',
        responseText: '42',
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ attempt: { id: first.attempt.id } });
    await expect(
      service.submitAttempt({
        actor: learner,
        cardId: session.cards[0]!.id,
        hintLevel: 0,
        idempotencyKey: 'attempt-1',
        learningProfileId: 'profile-1',
        perceivedDifficulty: 'hard',
        responseText: '43',
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });

    setNow(first.feedback.nextDueAt);
    const secondSession = await service.createShortReviewSession({
      actor: learner,
      learningProfileId: 'profile-1',
    });
    const hinted = await service.submitAttempt({
      actor: learner,
      cardId: secondSession.cards[0]!.id,
      hintLevel: 1,
      idempotencyKey: 'attempt-2',
      learningProfileId: 'profile-1',
      perceivedDifficulty: 'easy',
      responseText: '42',
      sessionId: secondSession.id,
    });
    expect(hinted.feedback.nextIntervalDays).toBe(3);

    setNow(hinted.feedback.nextDueAt);
    const thirdSession = await service.createShortReviewSession({
      actor: learner,
      learningProfileId: 'profile-1',
    });
    const wrong = await service.submitAttempt({
      actor: learner,
      cardId: thirdSession.cards[0]!.id,
      hintLevel: 0,
      idempotencyKey: 'attempt-3',
      learningProfileId: 'profile-1',
      responseText: '43',
      sessionId: thirdSession.id,
    });
    expect(wrong.feedback).toMatchObject({ nextIntervalDays: 1, outcome: 'incorrect' });
  });

  it('caps each short review at five due cards without mutating overflow cards', async () => {
    const { item, service } = await fixture();
    for (let index = 0; index < 7; index += 1) {
      const request = await service.requestReviewCard({
        actor: learner,
        ageBand: 'middle_primary',
        consentRevision: 1,
        familySpaceId: 'family-1',
        idempotencyKey: `cap-${index}`,
        learningProfileId: 'profile-1',
        wrongItemId: item.id,
      });
      await service.processRequest({ learningProfileId: 'profile-1', requestId: request.id });
    }
    const first = await service.createShortReviewSession({
      actor: learner,
      learningProfileId: 'profile-1',
    });
    const second = await service.createShortReviewSession({
      actor: learner,
      learningProfileId: 'profile-1',
    });
    expect(first.cards).toHaveLength(5);
    expect(second.cards).toHaveLength(5);
    expect(second.cardIds).toEqual(first.cardIds);
  });

  it('removes a contained or stale card from the queue and records a safe rebuild request', async () => {
    const { contained, item, service, setNow } = await fixture();
    const request = await service.requestReviewCard({
      actor: learner,
      ageBand: 'middle_primary',
      consentRevision: 1,
      familySpaceId: 'family-1',
      idempotencyKey: 'invalidate',
      learningProfileId: 'profile-1',
      wrongItemId: item.id,
    });
    await service.processRequest({ learningProfileId: 'profile-1', requestId: request.id });
    setNow('2026-09-12T10:00:00.000Z');
    const existingSession = await service.createShortReviewSession({
      actor: learner,
      learningProfileId: 'profile-1',
    });
    expect(existingSession.cards).toHaveLength(1);
    contained.value = true;

    await expect(
      service.getShortReviewSession({
        learningProfileId: 'profile-1',
        sessionId: existingSession.id,
      }),
    ).resolves.toMatchObject({ cardIds: [], cards: [] });

    await expect(
      service.getRequest({ learningProfileId: 'profile-1', requestId: request.id }),
    ).resolves.toMatchObject({
      card: null,
      rebuildPending: true,
      status: 'unavailable',
      unavailableReason: 'CAPABILITY_CONTAINED',
    });
    await expect(
      service.createShortReviewSession({ actor: learner, learningProfileId: 'profile-1' }),
    ).resolves.toMatchObject({ cards: [] });
  });
});
