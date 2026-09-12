import { describe, expect, it } from 'vitest';

import {
  evaluateWrongItemThemeMastery,
  MemoryThemeMasteryRepository,
  qualifyLearningEvidence,
  type LearningEvidence,
} from '../src/index.js';

function evidence(
  id: string,
  learningDate: string,
  overrides: Partial<LearningEvidence> = {},
): LearningEvidence {
  return {
    answerExposure: 'not_exposed',
    cycle: 1,
    familySpaceId: 'family-1',
    hintUsage: 'none',
    id,
    learningDate,
    learningProfileId: 'profile-1',
    occurredAt: `${learningDate}T09:00:00.000+08:00`,
    outcome: 'correct',
    qualification: 'independent_success',
    recordedAt: `${learningDate}T01:00:01.000Z`,
    sourceKind: 'review_card_attempt',
    sourceReferenceId: `attempt-${id}`,
    sourceVersions: {
      assessmentVersionId: 'assessment-version-1',
      basis: {
        contentHash: 'a'.repeat(64),
        selectionVersion: 1,
        sourceVersionId: 'basis-1',
        validityEpoch: 1,
      },
      capabilityVersionId: 'review-card-capability-1',
      classificationRevision: 1,
      gradingRuleVersionId: 'rule-1',
      questionContentHash: 'b'.repeat(64),
      questionVersionId: 'question-version-1',
      responseContentHash: 'c'.repeat(64),
      responseVersionId: 'response-version-1',
      reviewCardId: 'card-1',
      reviewCardVersion: 1,
      wrongItemStateRevision: 1,
    },
    themeId: 'topic:addition',
    variation: {
      differsFromOriginal: true,
      generationCheckPassed: true,
      kind: 'ai_checked_rewrite',
      questionContentHash: 'd'.repeat(64),
      sourceQuestionContentHash: 'b'.repeat(64),
    },
    wrongItemId: 'wrong-item-1',
    ...overrides,
  };
}

describe('wrong-item theme mastery policy', () => {
  it('requires independent success on two learning dates and a checked variation', () => {
    const first = evidence('evidence-1', '2026-09-12');
    const sameDayRepeat = evidence('evidence-2', '2026-09-12');

    expect(evaluateWrongItemThemeMastery([first, sameDayRepeat], 1)).toEqual({
      mastered: false,
      qualifyingEvidenceIds: ['evidence-1', 'evidence-2'],
    });

    expect(
      evaluateWrongItemThemeMastery(
        [first, sameDayRepeat, evidence('evidence-3', '2026-09-13')],
        1,
      ),
    ).toEqual({
      mastered: true,
      qualifyingEvidenceIds: ['evidence-1', 'evidence-2', 'evidence-3'],
    });
  });

  it('does not count a complete-answer-assisted or unchecked rewrite as independent evidence', () => {
    const fullAnswer = evidence('full-answer', '2026-09-13', {
      answerExposure: 'complete_answer_exposed_before_attempt',
      hintUsage: 'full_answer',
      qualification: 'assisted_success',
    });
    const uncheckedRewrite = evidence('unchecked', '2026-09-13', {
      variation: {
        differsFromOriginal: true,
        generationCheckPassed: false,
        kind: 'ai_checked_rewrite',
        questionContentHash: 'e'.repeat(64),
        sourceQuestionContentHash: 'b'.repeat(64),
      },
    });

    expect(qualifyLearningEvidence(fullAnswer)).toBe('assisted_success');
    expect(qualifyLearningEvidence(uncheckedRewrite)).toBe('assisted_success');
    expect(
      evaluateWrongItemThemeMastery(
        [evidence('independent', '2026-09-12'), fullAnswer, uncheckedRewrite],
        1,
      ).mastered,
    ).toBe(false);
  });

  it('ignores evidence from an earlier mastery cycle after a theme is reopened', () => {
    expect(
      evaluateWrongItemThemeMastery(
        [
          evidence('old-1', '2026-09-10'),
          evidence('old-2', '2026-09-11'),
          evidence('new-1', '2026-09-12', { cycle: 2 }),
        ],
        2,
      ),
    ).toEqual({ mastered: false, qualifyingEvidenceIds: ['new-1'] });
  });

  it('reopens a mastered theme before recording a later incorrect practice', () => {
    const repository = new MemoryThemeMasteryRepository();
    repository.registerTheme({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      occurredAt: '2026-09-10T01:00:00.000Z',
      reason: 'new_error',
      themeId: 'topic:addition',
      triggerKey: 'wrong-item:wrong-item-1',
    });
    for (const item of [evidence('correct-1', '2026-09-12'), evidence('correct-2', '2026-09-13')]) {
      const { cycle: _cycle, ...newEvidence } = item;
      repository.recordEvidence(newEvidence);
    }
    expect(repository.find('topic:addition', 'profile-1')?.status).toBe('mastered');

    const { cycle: _cycle, ...incorrect } = evidence('later-error', '2026-09-14', {
      outcome: 'incorrect',
      qualification: 'incorrect',
    });
    repository.recordEvidence(incorrect);

    expect(repository.find('topic:addition', 'profile-1')).toMatchObject({
      cycle: 2,
      evidence: expect.arrayContaining([
        expect.objectContaining({ cycle: 2, id: 'later-error', outcome: 'incorrect' }),
      ]),
      history: expect.arrayContaining([
        expect.objectContaining({ kind: 'reopened', reason: 'new_error' }),
      ]),
      status: 'active',
    });
  });

  it('does not reopen a mastered theme for an older event recorded out of order', () => {
    const repository = new MemoryThemeMasteryRepository();
    repository.registerTheme({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      occurredAt: '2026-09-10T01:00:00.000Z',
      reason: 'new_error',
      themeId: 'topic:addition',
      triggerKey: 'wrong-item:wrong-item-1',
    });
    for (const item of [evidence('correct-1', '2026-09-12'), evidence('correct-2', '2026-09-13')]) {
      const { cycle: _cycle, ...newEvidence } = item;
      repository.recordEvidence(newEvidence);
    }

    const { cycle: _cycle, ...olderIncorrect } = evidence(
      'older-error-recorded-late',
      '2026-09-11',
      {
        outcome: 'incorrect',
        qualification: 'incorrect',
      },
    );
    repository.recordEvidence(olderIncorrect);

    expect(repository.find('topic:addition', 'profile-1')).toMatchObject({
      cycle: 1,
      status: 'mastered',
    });
  });

  it('dates mastery from the latest qualifying event when evidence arrives out of order', () => {
    const repository = new MemoryThemeMasteryRepository();
    repository.registerTheme({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      occurredAt: '2026-09-10T01:00:00.000Z',
      reason: 'new_error',
      themeId: 'topic:addition',
      triggerKey: 'wrong-item:wrong-item-1',
    });
    for (const item of [evidence('newer', '2026-09-13'), evidence('older', '2026-09-12')]) {
      const { cycle: _cycle, ...newEvidence } = item;
      repository.recordEvidence(newEvidence);
    }

    expect(repository.find('topic:addition', 'profile-1')).toMatchObject({
      masteredAt: '2026-09-13T09:00:00.000+08:00',
      status: 'mastered',
    });

    const { cycle: _cycle, ...olderIncorrect } = evidence('intermediate-error', '2026-09-12', {
      occurredAt: '2026-09-12T12:00:00.000Z',
      outcome: 'incorrect',
      qualification: 'incorrect',
    });
    repository.recordEvidence(olderIncorrect);
    expect(repository.find('topic:addition', 'profile-1')).toMatchObject({
      cycle: 1,
      status: 'mastered',
    });
  });
});
