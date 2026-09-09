import type { CurrentLearningBasisReference, Subject } from '@rhea/learning-content';

export interface AssessmentActorReference {
  id: string;
  type: 'guardian' | 'learner';
}

export interface QuestionVersionSnapshot {
  contentHash: string;
  subject: Subject;
  text: string;
  versionId: string;
}

export interface ResponseVersionSnapshot {
  contentHash: string;
  text: string;
  versionId: string;
}

export interface NumericGradingRule {
  expected: string;
  kind: 'numeric';
}

export interface AcceptedTextGradingRule {
  acceptedAnswers: string[];
  caseSensitive: boolean;
  collapseWhitespace: boolean;
  kind: 'accepted_text';
}

export interface SingleChoiceGradingRule {
  correctOption: string;
  kind: 'single_choice';
}

export type ObjectiveGradingRule =
  AcceptedTextGradingRule | NumericGradingRule | SingleChoiceGradingRule;

export interface ObjectiveAssessmentDecision {
  expectedDisplay: string | null;
  normalizedResponse: string | null;
  outcome: 'correct' | 'incorrect' | 'ungradable';
  reasonCode: 'BASIS_INSUFFICIENT' | 'QUESTION_INSUFFICIENT' | null;
}

export interface ObjectiveAssessmentVersion {
  basis: CurrentLearningBasisReference;
  createdAt: string;
  createdBy: AssessmentActorReference;
  decision: ObjectiveAssessmentDecision;
  id: string;
  predecessorId: string | null;
  question: QuestionVersionSnapshot;
  response: ResponseVersionSnapshot;
  revision: number;
  rule: ObjectiveGradingRule | null;
}

export type AssessmentDisputeTarget = 'assessment' | 'question' | 'response';

export interface AssessmentDispute {
  assessmentVersionId: string;
  correctionText: string;
  id: string;
  raisedAt: string;
  raisedBy: AssessmentActorReference;
  reason: string;
  target: AssessmentDisputeTarget;
}

export interface AssessmentDisputeResolution {
  disputeId: string;
  id: string;
  priorAssessmentVersionId: string;
  reason: string;
  resolvedAt: string;
  resolvedBy: AssessmentActorReference & { type: 'guardian' };
  resultingAssessmentVersionId: string;
}

export interface DownstreamAssessmentReference {
  assessmentId: string;
  assessmentVersionId: string;
  basisSelectionVersion: number;
  basisSourceVersionId: string;
  basisValidityEpoch: number;
  outcome: 'correct' | 'incorrect';
  questionVersionId: string;
  responseVersionId: string;
  subject: Subject;
}

export interface ObjectiveAssessment {
  currentVersion: ObjectiveAssessmentVersion;
  disputes: AssessmentDispute[];
  familySpaceId: string;
  id: string;
  learningProfileId: string;
  materialId: string;
  openDisputeId: string | null;
  resolutions: AssessmentDisputeResolution[];
  versions: ObjectiveAssessmentVersion[];
}

export interface StoredObjectiveAssessment extends Omit<ObjectiveAssessment, 'currentVersion'> {
  deduplicationKey: string;
}
