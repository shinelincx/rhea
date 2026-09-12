import type { AssessmentActorReference, ObjectiveGradingRule } from '@rhea/assessment';
import type { CurrentLearningBasisReference, Subject } from '@rhea/learning-content';
import type { CapabilityVersion, DegradedReason } from '@rhea/quality-control';

export type ReviewCardAgeBand = 'lower_primary' | 'middle_primary' | 'upper_primary';
export type ReviewCardRequestStatus = 'generating' | 'queued' | 'ready' | 'unavailable';
export type ReviewCardUnavailableReason =
  | 'CAPABILITY_CONTAINED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CONSENT_WITHDRAWN'
  | 'GENERATION_CHECK_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'SOURCE_CHANGED';

export interface ReviewCardSourceSnapshot {
  ageBand: ReviewCardAgeBand;
  assessmentId: string;
  assessmentVersionId: string;
  basis: CurrentLearningBasisReference;
  classificationRevision: number;
  consentRevision: number;
  gradingRuleVersionId: string;
  knowledgePointName: string;
  originalExpectedAnswer: string;
  originalQuestion: string;
  originalQuestionContentHash: string;
  originalQuestionVersionId: string;
  originalResponse: string;
  originalResponseContentHash: string;
  originalResponseVersionId: string;
  subject: Subject;
  themeId: string;
  unitName: string | null;
  wrongItemId: string;
  wrongItemStateRevision: number;
  wrongItemStatus: 'pending_correction' | 'pending_consolidation';
}

export interface ReviewCardCandidate {
  explanationSteps: string[];
  expectedAnswer: string;
  gradingRule: ObjectiveGradingRule;
  keyChanges: string[];
  methodHint: string;
  orientationHint: string;
  question: string;
}

export interface ReviewCardModelTask {
  ageBand: ReviewCardAgeBand;
  capability: CapabilityVersion;
  constraints: {
    answerMustBeDeterministicallyVerifiable: true;
    doNotCopyOriginalQuestion: true;
    hintPolicy: 'orientation_then_method_then_feedback';
    maxExplanationSteps: 6;
    rewriteStrategy:
      | 'change_language_context_preserve_answer'
      | 'change_math_quantities_or_context_preserve_answer'
      | 'change_science_context_preserve_answer'
      | 'change_text_context_preserve_answer';
  };
  knowledgePointName: string;
  original: {
    expectedAnswer: string;
    question: string;
    response: string;
  };
  purpose: 'review_card';
  riskLevel: 'medium';
  subject: Subject;
  unitName: string | null;
}

export interface ReviewCardModelResult {
  candidate: ReviewCardCandidate;
  externalTraceId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: string;
}

export interface ReviewCardCheck {
  detail: string;
  kind: 'answer_leakage' | 'consistency' | 'rewrite' | 'safety' | 'schema';
  passed: boolean;
}

export interface ReviewCardModelRun {
  attempt: number;
  authorizationDecisionId: string;
  capabilityVersionId: string;
  externalTraceId: string | null;
  finishedAt: string;
  inputTokens: number | null;
  observedProvider: string | null;
  outputTokens: number | null;
  succeeded: boolean;
}

export interface ReviewCardSchedule {
  dueAt: string;
  intervalDays: 1 | 3 | 7 | 14 | 30;
  pendingCorrection: boolean;
  stepIndex: 0 | 1 | 2 | 3 | 4;
}

export interface StoredReviewCard {
  candidate: ReviewCardCandidate;
  capabilityVersionId: string;
  checks: ReviewCardCheck[];
  createdAt: string;
  familySpaceId: string;
  id: string;
  learningProfileId: string;
  requestId: string;
  schedule: ReviewCardSchedule;
  source: ReviewCardSourceSnapshot;
  status: 'active' | 'stale';
  version: number;
}

export interface StoredReviewCardRequest {
  actor: AssessmentActorReference;
  authorization: {
    containmentEpoch: number;
    decisionId: string;
    degradedReason: DegradedReason | null;
    issuedAt: string;
  };
  capability: CapabilityVersion | null;
  createdAt: string;
  currentCardId: string | null;
  familySpaceId: string;
  id: string;
  idempotencyKey: string;
  latestChecks: ReviewCardCheck[];
  learningProfileId: string;
  modelRuns: ReviewCardModelRun[];
  processingLeaseExpiresAt: string | null;
  rebuildPending: boolean;
  requestFingerprint: string;
  source: ReviewCardSourceSnapshot;
  stateRevision: number;
  status: ReviewCardRequestStatus;
  unavailableReason: ReviewCardUnavailableReason | null;
  updatedAt: string;
}

export interface ReviewCardRequestView {
  aiDisclosure: '我是 AI 学习助手，这张复习卡由 AI 重新生成并经过发布前检查。';
  card: ReviewCardView | null;
  createdAt: string;
  id: string;
  learningProfileId: string;
  rebuildPending: boolean;
  status: ReviewCardRequestStatus;
  unavailableReason: ReviewCardUnavailableReason | null;
  updatedAt: string;
}

export interface ReviewCardView {
  aiGenerated: true;
  content: {
    aiContentState: 'checked';
    keyChanges: string[];
    knowledgePointName: string;
    methodHint: string;
    orientationHint: string;
    question: string;
    subject: Subject;
    themeId: string;
  };
  id: string;
  original: {
    collapsedByDefault: true;
    currentLearningBasis: {
      sourceVersionId: string;
      validityEpoch: number;
      versionLabel: string;
    };
    question: string;
    relation: 'generated_from_wrong_item';
    response: string;
    wrongItemId: string;
  };
  schedule: ReviewCardSchedule;
  sourceVersion: {
    assessmentVersionId: string;
    capabilityVersionId: string;
    classificationRevision: number;
    wrongItemStateRevision: number;
  };
}

export interface ReviewAttemptFeedback {
  answer: string;
  currentState: 'pending_correction' | 'scheduled' | 'theme_mastered';
  evidenceQualification: 'assisted' | 'correction_required' | 'independent';
  explanationSteps: string[];
  hintImpact: string;
  nextAction: string;
  nextDueAt: string;
  nextIntervalDays: 1 | 3 | 7 | 14 | 30;
  outcome: 'correct' | 'incorrect';
}

export interface ReviewCardAttempt {
  cardId: string;
  createdAt: string;
  hintLevel: 0 | 1 | 2;
  id: string;
  idempotencyKey: string;
  outcome: 'correct' | 'incorrect';
  perceivedDifficulty: 'easy' | 'hard' | 'okay' | null;
  responseText: string;
  scheduleAfter: ReviewCardSchedule;
  scheduleBefore: ReviewCardSchedule;
  sessionId: string;
}

export interface ShortReviewSession {
  cardIds: string[];
  createdAt: string;
  id: string;
  learningProfileId: string;
}

export interface ShortReviewSessionView extends ShortReviewSession {
  cards: ReviewCardView[];
}
