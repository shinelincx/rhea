import { describe, expect, it } from 'vitest';

import {
  AssessmentService,
  MemoryAssessmentStore,
  type ObjectiveAssessmentInputReference,
  type ResolvedObjectiveAssessmentInput,
} from '../src/index.js';

const learner = { id: '00000000-0000-4000-8000-000000000001', type: 'learner' as const };
const guardian = { id: '00000000-0000-4000-8000-000000000003', type: 'guardian' as const };
const basis = {
  contentHash: 'a'.repeat(64),
  kind: 'answer' as const,
  materialId: '00000000-0000-4000-8000-000000000010',
  selectionVersion: 2,
  sourceVersionId: '00000000-0000-4000-8000-000000000011',
  validityEpoch: 1,
  versionLabel: '教师答案第 1 版',
};

function reference(suffix: string): ObjectiveAssessmentInputReference {
  return {
    confirmedContentVersionId: `content-${suffix}`,
    processingJobId: `job-${suffix}`,
    questionRegionId: `question-${suffix}`,
    responseRegionId: `response-${suffix}`,
  };
}

function trusted(input: {
  question?: string;
  response: string;
  rule: ResolvedObjectiveAssessmentInput['rule'];
  subject: ResolvedObjectiveAssessmentInput['question']['subject'];
  suffix: string;
}): ResolvedObjectiveAssessmentInput {
  return {
    gradingRuleVersionId: input.rule ? `trusted-rule-${input.suffix}` : null,
    question: {
      subject: input.subject,
      text: input.question ?? '已确认的客观题',
      versionId: `content-${input.suffix}:question-${input.suffix}`,
    },
    requiresProfessionalReview: false,
    response: {
      text: input.response,
      versionId: `content-${input.suffix}:response-${input.suffix}`,
    },
    rule: input.rule,
  };
}

function setup(entries: Record<string, ResolvedObjectiveAssessmentInput>) {
  const store = new MemoryAssessmentStore();
  const service = new AssessmentService({
    basisReader: { getCurrentBasisReference: async () => basis },
    inputReader: {
      resolveObjectiveInput: async ({ reference: inputReference }) =>
        structuredClone(entries[inputReference.questionRegionId] ?? null),
    },
    store,
  });
  return { service, store };
}

function grade(service: AssessmentService, inputReference: ObjectiveAssessmentInputReference) {
  return service.gradeObjective({
    actor: learner,
    familySpaceId: '00000000-0000-4000-8000-000000000002',
    inputReference,
    learningProfileId: learner.id,
    materialId: basis.materialId,
  });
}

describe('objective assessment', () => {
  it('grades only backend-resolved content and deduplicates the authoritative versions', async () => {
    const inputReference = reference('math');
    const { service } = setup({
      [inputReference.questionRegionId]: trusted({
        question: '6 × 7 = ?',
        response: '42.0',
        rule: { expected: '42', kind: 'numeric' },
        subject: 'mathematics',
        suffix: 'math',
      }),
    });

    const assessment = await grade(service, inputReference);

    expect(assessment.currentVersion).toMatchObject({
      basis: {
        contentHash: basis.contentHash,
        selectionVersion: 2,
        sourceVersionId: basis.sourceVersionId,
      },
      decision: { expectedDisplay: '42', normalizedResponse: '42', outcome: 'correct' },
      gradingRuleVersionId: 'trusted-rule-math',
      inputReference,
      question: { subject: 'mathematics', text: '6 × 7 = ?' },
      response: { text: '42.0' },
      revision: 1,
    });
    expect(assessment.currentVersion.question.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await grade(service, inputReference)).id).toBe(assessment.id);
  });

  it.each([
    {
      response: '啄木鸟',
      rule: {
        acceptedAnswers: ['啄木鸟'],
        caseSensitive: true,
        collapseWhitespace: true,
        kind: 'accepted_text' as const,
      },
      subject: 'chinese' as const,
    },
    {
      response: ' WENT ',
      rule: {
        acceptedAnswers: ['went'],
        caseSensitive: false,
        collapseWhitespace: true,
        kind: 'accepted_text' as const,
      },
      subject: 'english' as const,
    },
    {
      response: 'b',
      rule: { correctOption: 'B', kind: 'single_choice' as const },
      subject: 'science' as const,
    },
  ])(
    'deterministically grades a $subject objective sample',
    async ({ response, rule, subject }) => {
      const inputReference = reference(subject);
      const { service } = setup({
        [inputReference.questionRegionId]: trusted({ response, rule, subject, suffix: subject }),
      });

      expect((await grade(service, inputReference)).currentVersion.decision.outcome).toBe(
        'correct',
      );
    },
  );

  it.each([
    {
      expectedReason: 'QUESTION_INSUFFICIENT',
      question: '   ',
      rule: { expected: '42', kind: 'numeric' as const },
      suffix: 'missing-question',
    },
    {
      expectedReason: 'BASIS_INSUFFICIENT',
      question: '6 × 7 = ?',
      rule: null,
      suffix: 'missing-rule',
    },
  ])(
    'returns an explicit ungradable result for $expectedReason',
    async ({ expectedReason, question, rule, suffix }) => {
      const inputReference = reference(suffix);
      const { service } = setup({
        [inputReference.questionRegionId]: trusted({
          question,
          response: '42',
          rule,
          subject: 'mathematics',
          suffix,
        }),
      });

      expect((await grade(service, inputReference)).currentVersion.decision).toMatchObject({
        expectedDisplay: null,
        outcome: 'ungradable',
        reasonCode: expectedReason,
      });
    },
  );

  it('pauses a response dispute and regrades only from a new trusted input reference', async () => {
    const originalReference = reference('original');
    const correctedReference = reference('corrected');
    const englishRule = {
      acceptedAnswers: ['went'],
      caseSensitive: false,
      collapseWhitespace: true,
      kind: 'accepted_text' as const,
    };
    const { service } = setup({
      [originalReference.questionRegionId]: trusted({
        question: 'Past tense of go?',
        response: 'goed',
        rule: englishRule,
        subject: 'english',
        suffix: 'original',
      }),
      [correctedReference.questionRegionId]: trusted({
        question: 'Past tense of go?',
        response: 'went',
        rule: englishRule,
        subject: 'english',
        suffix: 'corrected',
      }),
    });
    const original = await grade(service, originalReference);
    await expect(
      service.getDownstreamReference({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: learner.id,
      }),
    ).resolves.toMatchObject({ outcome: 'incorrect' });

    const disputed = await service.raiseDispute({
      actor: learner,
      assessmentId: original.id,
      correctionText: '识别出的作答少了字母 n，我写的是 went。',
      learningProfileId: learner.id,
      reason: '识别内容不对',
      target: 'response',
    });
    expect(disputed.disputes[0]).toMatchObject({ reviewRoute: 'guardian', target: 'response' });
    await expect(
      service.getDownstreamReference({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: learner.id,
      }),
    ).rejects.toMatchObject({ code: 'DOWNSTREAM_INELIGIBLE' });
    await expect(
      service.resolveDispute({
        actor: learner,
        assessmentId: original.id,
        disputeId: disputed.openDisputeId!,
        inputReference: correctedReference,
        learningProfileId: learner.id,
        reason: '确认识别修正',
      }),
    ).rejects.toMatchObject({ code: 'DISPUTE_RESOLUTION_REQUIRES_GUARDIAN' });

    const resolved = await service.resolveDispute({
      actor: guardian,
      assessmentId: original.id,
      disputeId: disputed.openDisputeId!,
      inputReference: correctedReference,
      learningProfileId: learner.id,
      reason: '监护人核对新确认版本后确认识别修正',
    });

    expect(resolved).toMatchObject({
      currentVersion: {
        decision: { outcome: 'correct' },
        inputReference: correctedReference,
        predecessorId: original.currentVersion.id,
        revision: 2,
      },
      openDisputeId: null,
      resolutions: [
        {
          disputeId: disputed.openDisputeId,
          priorAssessmentVersionId: original.currentVersion.id,
          resultingAssessmentVersionId: resolved.currentVersion.id,
          resolvedBy: { type: 'guardian' },
        },
      ],
      versions: [{ revision: 1 }, { revision: 2 }],
    });
  });

  it('routes grading-conclusion disputes to professional review instead of guardian override', async () => {
    const inputReference = reference('review');
    const { service } = setup({
      [inputReference.questionRegionId]: trusted({
        response: 'A',
        rule: { correctOption: 'B', kind: 'single_choice' },
        subject: 'science',
        suffix: 'review',
      }),
    });
    const assessment = await grade(service, inputReference);
    const disputed = await service.raiseDispute({
      actor: learner,
      assessmentId: assessment.id,
      correctionText: '这个答案也可能合理。',
      learningProfileId: learner.id,
      reason: '采用答案没有覆盖合理回答',
      target: 'assessment',
    });

    expect(disputed.disputes[0]?.reviewRoute).toBe('professional');
    await expect(
      service.resolveDispute({
        actor: guardian,
        assessmentId: assessment.id,
        disputeId: disputed.openDisputeId!,
        learningProfileId: learner.id,
        reason: '尝试普通复核',
      }),
    ).rejects.toMatchObject({ code: 'PROFESSIONAL_REVIEW_REQUIRED' });
  });

  it('fails current reads closed when the selected learning basis changes', async () => {
    let currentBasis = basis;
    const inputReference = reference('basis-change');
    const store = new MemoryAssessmentStore();
    const service = new AssessmentService({
      basisReader: { getCurrentBasisReference: async () => currentBasis },
      inputReader: {
        resolveObjectiveInput: async () =>
          trusted({
            response: 'A',
            rule: { correctOption: 'A', kind: 'single_choice' },
            subject: 'science',
            suffix: 'basis-change',
          }),
      },
      store,
    });
    const assessment = await grade(service, inputReference);
    currentBasis = { ...basis, selectionVersion: 3 };

    await expect(
      service.getAssessment({
        actor: learner,
        assessmentId: assessment.id,
        learningProfileId: learner.id,
      }),
    ).rejects.toMatchObject({ code: 'BASIS_CHANGED' });
  });
});
