export const WRONG_ITEM_THEME_MASTERY_POLICY_VERSION = 'wrong-item-theme-mastery-v1' as const;

export type LearningEvidenceSourceKind =
  'immediate_correction' | 'review_card_attempt' | 'wrong_item_capture';
export type LearningEvidenceHintUsage = 'full_answer' | 'method' | 'none' | 'orientation';
export type LearningEvidenceQualification =
  'assisted_success' | 'incorrect' | 'independent_success';
export type WrongItemThemeMasteryStatus = 'active' | 'mastered';

export interface LearningEvidenceSourceVersions {
  assessmentVersionId: string;
  basis: {
    contentHash: string;
    selectionVersion: number;
    sourceVersionId: string;
    validityEpoch: number;
  };
  capabilityVersionId: string | null;
  classificationRevision: number;
  gradingRuleVersionId: string;
  questionContentHash: string;
  questionVersionId: string;
  responseContentHash: string;
  responseVersionId: string;
  reviewCardId: string | null;
  reviewCardVersion: number | null;
  wrongItemStateRevision: number;
}

export interface LearningEvidenceVariation {
  differsFromOriginal: boolean;
  generationCheckPassed: boolean;
  kind: 'ai_checked_rewrite' | 'original';
  questionContentHash: string;
  sourceQuestionContentHash: string;
}

export interface NewLearningEvidence {
  answerExposure: 'complete_answer_exposed_before_attempt' | 'not_exposed';
  familySpaceId: string;
  hintUsage: LearningEvidenceHintUsage;
  id: string;
  learningDate: string;
  learningProfileId: string;
  occurredAt: string;
  outcome: 'correct' | 'incorrect';
  qualification: LearningEvidenceQualification;
  recordedAt: string;
  sourceKind: LearningEvidenceSourceKind;
  sourceReferenceId: string;
  sourceVersions: LearningEvidenceSourceVersions;
  themeId: string;
  variation: LearningEvidenceVariation;
  wrongItemId: string;
}

export interface LearningEvidence extends NewLearningEvidence {
  cycle: number;
}

export interface WrongItemThemeMasteryTransition {
  cycle: number;
  evidenceIds: string[];
  fromStatus: WrongItemThemeMasteryStatus | null;
  id: string;
  kind: 'cycle_started' | 'mastered' | 'reopened';
  occurredAt: string;
  reason:
    | 'classification_changed'
    | 'first_error'
    | 'new_error'
    | 'rule_satisfied'
    | 'source_invalidated';
  toStatus: WrongItemThemeMasteryStatus;
  triggerKey: string;
}

export interface WrongItemThemeMasteryView {
  cycle: number;
  evidence: LearningEvidence[];
  familySpaceId: string;
  history: WrongItemThemeMasteryTransition[];
  learningProfileId: string;
  masteredAt: string | null;
  openedAt: string;
  policyVersion: typeof WRONG_ITEM_THEME_MASTERY_POLICY_VERSION;
  stateRevision: number;
  status: WrongItemThemeMasteryStatus;
  themeId: string;
}

export interface WrongItemThemeMasteryDecision {
  mastered: boolean;
  qualifyingEvidenceIds: string[];
}

export interface ThemeMasteryRepository {
  find(themeId: string, learningProfileId: string): WrongItemThemeMasteryView | null;
  recordEvidence(evidence: NewLearningEvidence): WrongItemThemeMasteryView | null;
  registerTheme(input: {
    familySpaceId: string;
    learningProfileId: string;
    occurredAt: string;
    reason: 'classification_changed' | 'first_error' | 'new_error';
    themeId: string;
    triggerKey: string;
  }): WrongItemThemeMasteryView;
  reopenForInvalidSource(input: {
    learningProfileId: string;
    occurredAt: string;
    themeId: string;
    triggerKey: string;
  }): WrongItemThemeMasteryView | null;
}

export function qualifyLearningEvidence(
  evidence: Pick<
    NewLearningEvidence,
    'answerExposure' | 'hintUsage' | 'outcome' | 'sourceKind' | 'variation'
  >,
): LearningEvidenceQualification {
  if (evidence.outcome === 'incorrect') return 'incorrect';
  if (
    evidence.sourceKind !== 'review_card_attempt' ||
    evidence.hintUsage !== 'none' ||
    evidence.answerExposure !== 'not_exposed' ||
    evidence.variation.kind !== 'ai_checked_rewrite' ||
    !evidence.variation.differsFromOriginal ||
    !evidence.variation.generationCheckPassed
  ) {
    return 'assisted_success';
  }
  return 'independent_success';
}

export function evaluateWrongItemThemeMastery(
  evidence: readonly LearningEvidence[],
  cycle: number,
): WrongItemThemeMasteryDecision {
  const qualifying = evidence.filter(
    (item) =>
      item.cycle === cycle &&
      item.qualification === 'independent_success' &&
      qualifyLearningEvidence(item) === 'independent_success',
  );
  const learningDates = new Set(qualifying.map(({ learningDate }) => learningDate));
  const includesCheckedVariation = qualifying.some(
    ({ variation }) =>
      variation.kind === 'ai_checked_rewrite' &&
      variation.differsFromOriginal &&
      variation.generationCheckPassed,
  );
  return {
    mastered: learningDates.size >= 2 && includesCheckedVariation,
    qualifyingEvidenceIds: qualifying.map(({ id }) => id),
  };
}

export function learningDateInShanghai(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid learning event time');
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
