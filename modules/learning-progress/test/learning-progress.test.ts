import { describe, expect, it } from 'vitest';

import { AssessmentError, type AcceptedObjectiveAssessmentSnapshot } from '@rhea/assessment';

import {
  LearningProgressService,
  MemoryLearningProgressStore,
  type AcceptedObjectiveAssessmentReader,
} from '../src/index.js';

const guardian = { id: 'guardian-1', type: 'guardian' } as const;
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

function snapshot(
  overrides: Partial<AcceptedObjectiveAssessmentSnapshot> = {},
): AcceptedObjectiveAssessmentSnapshot {
  return {
    assessmentId: 'assessment-1',
    assessmentVersionId: 'assessment-version-1',
    basis,
    correctBasis: { expectedDisplay: '42', gradingRuleVersionId: 'rule-1' },
    familySpaceId: 'family-1',
    firstIncorrectAt: '2026-09-11T08:00:00.000Z',
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
    response: {
      contentHash: 'c'.repeat(64),
      text: '41',
      versionId: 'response-version-1',
    },
    ...overrides,
  };
}

function fixture(
  options: {
    classification?: {
      knowledgePointNames: string[];
      primaryKnowledgePointName: string | null;
      unitName: string | null;
    };
    source?: AcceptedObjectiveAssessmentSnapshot;
  } = {},
) {
  let source = options.source ?? snapshot();
  const reader: AcceptedObjectiveAssessmentReader = {
    async evaluateImmediateCorrection(input) {
      return {
        assessmentId: source.assessmentId,
        assessmentVersionId: source.assessmentVersionId,
        basis: structuredClone(source.basis),
        evaluatedResponse: input.responseText.trim(),
        expectedDisplay: source.correctBasis.expectedDisplay,
        normalizedResponse: input.responseText.trim(),
        outcome:
          input.responseText.trim() === source.correctBasis.expectedDisplay
            ? 'correct'
            : 'incorrect',
      };
    },
    async getAcceptedObjectiveAssessmentSnapshot() {
      if (source.outcome === 'correct') return structuredClone(source);
      return structuredClone(source);
    },
  };
  const service = new LearningProgressService({
    assessmentReader: reader,
    clock: { now: new Date('2026-09-11T09:00:00.000Z') },
    learningContextReader: {
      async getCurrentLearningContextReference() {
        const classification = options.classification ?? {
          knowledgePointNames: ['两位数加法'],
          primaryKnowledgePointName: '两位数加法',
          unitName: '加法',
        };
        return {
          basis: structuredClone(source.basis),
          classificationRevision: 1,
          confirmedContentVersionId: source.inputReference.confirmedContentVersionId,
          coursePathName: '数学上册',
          ...classification,
          subject: source.question.subject,
        };
      },
    },
    store: new MemoryLearningProgressStore(),
  });
  return {
    reader,
    service,
    setSource(next: AcceptedObjectiveAssessmentSnapshot) {
      source = next;
    },
  };
}

describe('LearningProgressService wrong-item library', () => {
  it('captures only accepted errors and deduplicates repeated capture', async () => {
    const correct = fixture({ source: snapshot({ outcome: 'correct' }) });
    await expect(
      correct.service.captureAcceptedError({
        actor: learner,
        assessmentId: 'assessment-1',
        learningProfileId: 'profile-1',
      }),
    ).resolves.toBeNull();

    const { service } = fixture();
    const first = await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    });
    const retried = await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    });

    expect(retried?.id).toBe(first?.id);
    await expect(
      service.listWrongItems({ actor: learner, learningProfileId: 'profile-1' }),
    ).resolves.toMatchObject({ items: [{ id: first?.id }], themes: [{ itemCount: 1 }] });
  });

  it('preserves the original evidence, correct basis, lineage, and first error time', async () => {
    const { service } = fixture();
    const item = await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    });

    expect(item).toMatchObject({
      assessment: {
        basis: { sourceVersionId: 'basis-1', validityEpoch: 1 },
        correctBasis: { expectedDisplay: '42', gradingRuleVersionId: 'rule-1' },
        question: { text: '40 + 2 等于多少？', versionId: 'question-version-1' },
        response: { text: '41', versionId: 'response-version-1' },
      },
      firstIncorrectAt: '2026-09-11T08:00:00.000Z',
      status: 'pending_correction',
    });
  });

  it('groups classified mistakes by knowledge topic and keeps unclassified items pending', async () => {
    const classified = fixture();
    await classified.service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    });
    await expect(
      classified.service.listWrongItems({
        actor: learner,
        filter: {
          knowledgePointName: '两位数加法',
          subject: 'mathematics',
          unitName: '加法',
        },
        learningProfileId: 'profile-1',
      }),
    ).resolves.toMatchObject({
      items: [{ classification: { status: 'classified' } }],
      themes: [{ itemCount: 1, knowledgePointName: '两位数加法' }],
    });

    const pending = fixture({
      classification: {
        knowledgePointNames: [],
        primaryKnowledgePointName: null,
        unitName: null,
      },
    });
    await pending.service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    });
    await expect(
      pending.service.listWrongItems({
        actor: learner,
        filter: { classificationStatus: 'pending' },
        learningProfileId: 'profile-1',
      }),
    ).resolves.toMatchObject({
      items: [{ classification: { status: 'pending' } }],
      themes: [{ knowledgePointName: null, status: 'pending' }],
    });
  });

  it('keeps the reason as a hypothesis that learners can question and guardians can correct', async () => {
    const { service } = fixture();
    const captured = (await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    }))!;
    expect(captured.currentReason).toMatchObject({ status: 'suggested' });
    expect(captured.reasonCandidate.hypothesisDisclosure).toContain('可能错因');

    const uncertain = await service.reviseReason({
      action: 'mark_uncertain',
      actor: learner,
      expectedStateRevision: captured.stateRevision,
      learningProfileId: 'profile-1',
      reason: '我不确定是不是计算步骤的问题。',
      wrongItemId: captured.id,
    });
    expect(uncertain.currentReason.status).toBe('uncertain');

    const corrected = await service.reviseReason({
      action: 'correct',
      actor: guardian,
      category: 'comprehension',
      expectedStateRevision: uncertain.stateRevision,
      explanation: '可能漏看了题目中的一个条件。',
      learningProfileId: 'profile-1',
      reason: '结合纸面过程修正。',
      wrongItemId: uncertain.id,
    });
    expect(corrected.currentReason).toEqual({
      category: 'comprehension',
      explanation: '可能漏看了题目中的一个条件。',
      status: 'corrected',
    });
  });

  it('records an immediate correction against the original error without claiming mastery', async () => {
    const { service } = fixture();
    const captured = (await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    }))!;
    const corrected = await service.submitImmediateCorrection({
      actor: learner,
      expectedStateRevision: captured.stateRevision,
      idempotencyKey: 'correction-command-1',
      learningProfileId: 'profile-1',
      responseText: '42',
      wrongItemId: captured.id,
    });
    const retried = await service.submitImmediateCorrection({
      actor: learner,
      expectedStateRevision: captured.stateRevision,
      idempotencyKey: 'correction-command-1',
      learningProfileId: 'profile-1',
      responseText: '42',
      wrongItemId: captured.id,
    });

    expect(corrected).toMatchObject({
      correctionAttempts: [
        {
          assessmentVersionId: 'assessment-version-1',
          basis: { sourceVersionId: 'basis-1' },
          outcome: 'correct',
          responseText: '42',
        },
      ],
      status: 'pending_consolidation',
    });
    expect(retried.correctionAttempts).toHaveLength(1);
    await expect(
      service.getWrongItemThemeMastery({
        actor: learner,
        learningProfileId: 'profile-1',
        themeId: captured.themeId,
      }),
    ).resolves.toMatchObject({
      evidence: expect.arrayContaining([
        expect.objectContaining({
          answerExposure: 'complete_answer_exposed_before_attempt',
          hintUsage: 'full_answer',
          qualification: 'assisted_success',
          sourceKind: 'immediate_correction',
        }),
      ]),
      status: 'active',
    });
  });

  it('fails closed while a grading result is disputed or superseded', async () => {
    const { service, setSource } = fixture();
    const captured = (await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    }))!;
    setSource(snapshot({ assessmentVersionId: 'assessment-version-2', outcome: 'correct' }));

    await expect(
      service.getWrongItem({
        actor: learner,
        learningProfileId: 'profile-1',
        wrongItemId: captured.id,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_INELIGIBLE' });
    await expect(
      service.listWrongItems({ actor: learner, learningProfileId: 'profile-1' }),
    ).resolves.toEqual({ items: [], themes: [] });
  });

  it('omits disputed items from the active library', async () => {
    let disputed = false;
    const base = fixture();
    const reader: AcceptedObjectiveAssessmentReader = {
      ...base.reader,
      async getAcceptedObjectiveAssessmentSnapshot(input) {
        if (disputed) {
          throw new AssessmentError('DOWNSTREAM_INELIGIBLE', '批改质疑尚未解决');
        }
        return base.reader.getAcceptedObjectiveAssessmentSnapshot(input);
      },
    };
    const service = new LearningProgressService({
      assessmentReader: reader,
      learningContextReader: {
        async getCurrentLearningContextReference() {
          return {
            basis,
            classificationRevision: 1,
            confirmedContentVersionId: 'content-1',
            coursePathName: null,
            knowledgePointNames: ['两位数加法'],
            primaryKnowledgePointName: '两位数加法',
            subject: 'mathematics',
            unitName: '加法',
          };
        },
      },
      store: new MemoryLearningProgressStore(),
    });
    await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    });
    disputed = true;

    await expect(
      service.listWrongItems({ actor: learner, learningProfileId: 'profile-1' }),
    ).resolves.toEqual({ items: [], themes: [] });
  });

  it('allows explicit classification correction and rejects learner labels in reasons', async () => {
    const { service } = fixture({
      classification: {
        knowledgePointNames: [],
        primaryKnowledgePointName: null,
        unitName: null,
      },
    });
    const captured = (await service.captureAcceptedError({
      actor: learner,
      assessmentId: 'assessment-1',
      learningProfileId: 'profile-1',
    }))!;
    const classified = await service.reviseClassification({
      actor: learner,
      expectedStateRevision: captured.stateRevision,
      knowledgePointNames: ['进位加法'],
      learningProfileId: 'profile-1',
      primaryKnowledgePointName: '进位加法',
      subject: 'mathematics',
      unitName: '加法',
      wrongItemId: captured.id,
    });
    expect(classified.classification).toMatchObject({
      primaryKnowledgePointName: '进位加法',
      status: 'classified',
    });
    await expect(
      service.reviseReason({
        action: 'correct',
        actor: learner,
        category: 'other',
        expectedStateRevision: classified.stateRevision,
        explanation: '因为我很笨。',
        learningProfileId: 'profile-1',
        reason: '自我判断',
        wrongItemId: classified.id,
      }),
    ).rejects.toMatchObject({ code: 'REASON_REVISION_INVALID' });
  });
});
