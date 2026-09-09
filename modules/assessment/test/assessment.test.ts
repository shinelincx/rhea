import { describe, expect, it } from 'vitest';

import { AssessmentService, MemoryAssessmentStore } from '../src/index.js';

const learner = { id: '00000000-0000-4000-8000-000000000001', type: 'learner' as const };
const basis = {
  contentHash: 'a'.repeat(64),
  kind: 'answer' as const,
  materialId: '00000000-0000-4000-8000-000000000010',
  selectionVersion: 2,
  sourceVersionId: '00000000-0000-4000-8000-000000000011',
  validityEpoch: 1,
  versionLabel: '教师答案第 1 版',
};

function setup() {
  const service = new AssessmentService({
    basisReader: {
      getCurrentBasisReference: async () => basis,
    },
    store: new MemoryAssessmentStore(),
  });
  return { service };
}

describe('objective assessment', () => {
  it('deterministically grades a mathematics numeric answer with a traceable basis', async () => {
    const { service } = setup();

    const assessment = await service.gradeObjective({
      actor: learner,
      familySpaceId: '00000000-0000-4000-8000-000000000002',
      learningProfileId: learner.id,
      materialId: basis.materialId,
      question: {
        contentHash: 'b'.repeat(64),
        subject: 'mathematics',
        text: '6 × 7 = ?',
        versionId: '00000000-0000-4000-8000-000000000020',
      },
      response: {
        contentHash: 'c'.repeat(64),
        text: '42.0',
        versionId: '00000000-0000-4000-8000-000000000021',
      },
      rule: { expected: '42', kind: 'numeric' },
    });

    expect(assessment.currentVersion).toMatchObject({
      basis: {
        contentHash: basis.contentHash,
        selectionVersion: 2,
        sourceVersionId: basis.sourceVersionId,
      },
      decision: {
        expectedDisplay: '42',
        normalizedResponse: '42',
        outcome: 'correct',
      },
      question: { subject: 'mathematics', text: '6 × 7 = ?' },
      response: { text: '42.0' },
      revision: 1,
    });

    const retried = await service.gradeObjective({
      actor: learner,
      familySpaceId: '00000000-0000-4000-8000-000000000002',
      learningProfileId: learner.id,
      materialId: basis.materialId,
      question: {
        contentHash: 'b'.repeat(64),
        subject: 'mathematics',
        text: '6 × 7 = ?',
        versionId: '00000000-0000-4000-8000-000000000020',
      },
      response: {
        contentHash: 'c'.repeat(64),
        text: '42.0',
        versionId: '00000000-0000-4000-8000-000000000021',
      },
      rule: { expected: '42', kind: 'numeric' },
    });
    expect(retried.id).toBe(assessment.id);
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
      const { service } = setup();

      const assessment = await service.gradeObjective({
        actor: learner,
        familySpaceId: '00000000-0000-4000-8000-000000000002',
        learningProfileId: learner.id,
        materialId: basis.materialId,
        question: {
          contentHash: 'd'.repeat(64),
          subject,
          text: '已确认的客观题',
          versionId: '00000000-0000-4000-8000-000000000030',
        },
        response: {
          contentHash: 'e'.repeat(64),
          text: response,
          versionId: '00000000-0000-4000-8000-000000000031',
        },
        rule,
      });

      expect(assessment.currentVersion.decision.outcome).toBe('correct');
    },
  );

  it.each([
    {
      expectedReason: 'QUESTION_INSUFFICIENT',
      questionText: '   ',
      rule: { expected: '42', kind: 'numeric' as const },
    },
    {
      expectedReason: 'BASIS_INSUFFICIENT',
      questionText: '6 × 7 = ?',
      rule: null,
    },
  ])(
    'returns an explicit ungradable result for $expectedReason',
    async ({ expectedReason, questionText, rule }) => {
      const { service } = setup();

      const assessment = await service.gradeObjective({
        actor: learner,
        familySpaceId: '00000000-0000-4000-8000-000000000002',
        learningProfileId: learner.id,
        materialId: basis.materialId,
        question: {
          contentHash: 'b'.repeat(64),
          subject: 'mathematics',
          text: questionText,
          versionId: '00000000-0000-4000-8000-000000000040',
        },
        response: {
          contentHash: 'c'.repeat(64),
          text: '42',
          versionId: '00000000-0000-4000-8000-000000000041',
        },
        rule,
      });

      expect(assessment.currentVersion.decision).toMatchObject({
        expectedDisplay: null,
        outcome: 'ungradable',
        reasonCode: expectedReason,
      });
    },
  );

  it('pauses disputed results and regrades from corrected information with an audit chain', async () => {
    const { service } = setup();
    const original = await service.gradeObjective({
      actor: learner,
      familySpaceId: '00000000-0000-4000-8000-000000000002',
      learningProfileId: learner.id,
      materialId: basis.materialId,
      question: {
        contentHash: '1'.repeat(64),
        subject: 'english',
        text: 'Past tense of go?',
        versionId: '00000000-0000-4000-8000-000000000050',
      },
      response: {
        contentHash: '2'.repeat(64),
        text: 'goed',
        versionId: '00000000-0000-4000-8000-000000000051',
      },
      rule: {
        acceptedAnswers: ['went'],
        caseSensitive: false,
        collapseWhitespace: true,
        kind: 'accepted_text',
      },
    });
    await expect(
      service.getDownstreamReference({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: learner.id,
      }),
    ).resolves.toMatchObject({
      assessmentVersionId: original.currentVersion.id,
      outcome: 'incorrect',
      responseVersionId: original.currentVersion.response.versionId,
    });

    const disputed = await service.raiseDispute({
      actor: learner,
      assessmentId: original.id,
      correctionText: '识别出的作答少了字母 n，我写的是 went。',
      learningProfileId: learner.id,
      reason: '识别内容不对',
      target: 'response',
    });
    expect(disputed).toMatchObject({
      openDisputeId: disputed.disputes[0]?.id,
      disputes: [
        {
          assessmentVersionId: original.currentVersion.id,
          raisedBy: learner,
          target: 'response',
        },
      ],
    });
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
        correctedResponse: {
          contentHash: '3'.repeat(64),
          text: 'went',
          versionId: '00000000-0000-4000-8000-000000000052',
        },
        disputeId: disputed.openDisputeId!,
        learningProfileId: learner.id,
        reason: '确认识别修正',
      }),
    ).rejects.toMatchObject({ code: 'DISPUTE_RESOLUTION_REQUIRES_GUARDIAN' });

    const resolved = await service.resolveDispute({
      actor: { id: '00000000-0000-4000-8000-000000000003', type: 'guardian' },
      assessmentId: original.id,
      correctedResponse: {
        contentHash: '3'.repeat(64),
        text: 'went',
        versionId: '00000000-0000-4000-8000-000000000052',
      },
      disputeId: disputed.openDisputeId!,
      learningProfileId: learner.id,
      reason: '监护人核对原稿后确认识别修正',
    });

    expect(resolved).toMatchObject({
      currentVersion: {
        decision: { outcome: 'correct' },
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
    await expect(
      service.getDownstreamReference({
        actor: learner,
        assessmentId: original.id,
        learningProfileId: learner.id,
      }),
    ).resolves.toMatchObject({
      assessmentVersionId: resolved.currentVersion.id,
      outcome: 'correct',
    });
  });

  it('fails current reads closed when the selected learning basis changes', async () => {
    let currentBasis = basis;
    const service = new AssessmentService({
      basisReader: { getCurrentBasisReference: async () => currentBasis },
      store: new MemoryAssessmentStore(),
    });
    const assessment = await service.gradeObjective({
      actor: learner,
      familySpaceId: '00000000-0000-4000-8000-000000000002',
      learningProfileId: learner.id,
      materialId: basis.materialId,
      question: {
        contentHash: '4'.repeat(64),
        subject: 'science',
        text: '植物生长是否需要水？',
        versionId: '00000000-0000-4000-8000-000000000060',
      },
      response: {
        contentHash: '5'.repeat(64),
        text: 'A',
        versionId: '00000000-0000-4000-8000-000000000061',
      },
      rule: { correctOption: 'A', kind: 'single_choice' },
    });
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
