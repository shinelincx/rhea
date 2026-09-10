import type { CurrentLearningBasisReference, Subject } from '@rhea/learning-content';
import type { CapabilityVersion, DegradedReason } from '@rhea/quality-control';

import type {
  AssessmentActorReference,
  ObjectiveAssessmentInputReference,
  ProfessionalReviewerReference,
} from './types.js';

export type OpenAssessmentAgeBand = 'lower_primary' | 'middle_primary' | 'upper_primary';

export type OpenAssessmentTaskType =
  'chinese_expression' | 'mathematics_process' | 'english_expression' | 'science_inquiry';

export type RubricSourceAuthority = 'teacher' | 'formal_exam' | 'rhea_professionally_reviewed';

export type DimensionEvidenceState =
  'demonstrated' | 'partially_demonstrated' | 'not_demonstrated' | 'insufficient_evidence';

export interface OpenAssessmentRubricDimension {
  description: string;
  key: string;
  label: string;
  required: boolean;
}

export interface OpenAssessmentRubricSnapshot {
  ageBand: OpenAssessmentAgeBand;
  dimensions: OpenAssessmentRubricDimension[];
  id: string;
  name: string;
  source: {
    authority: RubricSourceAuthority;
    label: string;
  };
  subject: Subject;
  taskType: OpenAssessmentTaskType;
  version: string;
}

export interface ResolvedOpenAssessmentInput {
  question: {
    subject: Subject;
    text: string;
    versionId: string;
  };
  requiresProfessionalReview: boolean;
  response: {
    text: string;
    versionId: string;
  };
  rubric: OpenAssessmentRubricSnapshot | null;
}

export interface OpenAssessmentDimensionSuggestion {
  confidence: number;
  dimensionKey: string;
  evidenceExcerpt: string | null;
  improvementSuggestion: string;
  observation: string;
  state: DimensionEvidenceState;
}

export interface OpenAssessmentModelCandidate {
  confidence: number;
  dimensions: OpenAssessmentDimensionSuggestion[];
  improvementDimensionKey: string;
  nextAction: string;
  strengthEvidence: string;
}

export interface OpenAssessmentModelTask {
  ageBand: OpenAssessmentAgeBand;
  capability: CapabilityVersion;
  learningBasis: Pick<
    CurrentLearningBasisReference,
    | 'contentHash'
    | 'kind'
    | 'selectionVersion'
    | 'sourceVersionId'
    | 'validityEpoch'
    | 'versionLabel'
  >;
  purpose: 'open_assessment_suggestion';
  question: { subject: Subject; text: string };
  response: { text: string };
  rubric: OpenAssessmentRubricSnapshot;
  taskType: OpenAssessmentTaskType;
}

export interface OpenAssessmentModelResult {
  candidate: OpenAssessmentModelCandidate;
  externalTraceId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: string;
}

export interface OpenAssessmentModelRun {
  authorizationDecisionId: string;
  capabilityVersionId: string;
  externalTraceId: string | null;
  finishedAt: string;
  inputTokens: number | null;
  modelOrEngineVersion: string;
  observedProvider: string | null;
  outputTokens: number | null;
  promptOrConfigVersion: string;
  provider: string;
  providerVersion: string;
  succeeded: boolean;
}

export type SuggestedAssessmentStatus = 'pending_review' | 'accepted' | 'rejected' | 'unavailable';

export type SuggestedAssessmentUnavailableReason =
  | 'CAPABILITY_UNAVAILABLE'
  | 'LOW_CONFIDENCE'
  | 'MODEL_UNAVAILABLE'
  | 'RUBRIC_REQUIRED'
  | 'SOURCE_CHANGED';

export interface SuggestedAssessmentAuthorizationSnapshot {
  containmentEpoch: number;
  decisionId: string;
  degradedReason: DegradedReason | null;
  issuedAt: string;
}

export interface AcceptedOpenAssessmentResultReference {
  assessmentId: string;
  assessmentVersionId: string;
  basisSelectionVersion: number;
  basisSourceVersionId: string;
  basisValidityEpoch: number;
  questionVersionId: string;
  responseVersionId: string;
  rubricId: string;
  rubricVersion: string;
  subject: Subject;
}

export type OpenAssessmentReviewerReference =
  (AssessmentActorReference & { type: 'guardian' }) | ProfessionalReviewerReference;

export type OpenAssessmentReviewDecision =
  | {
      action: 'accept';
      dimensionKey: string;
    }
  | {
      action: 'modify';
      dimensionKey: string;
      modification: Omit<OpenAssessmentDimensionSuggestion, 'confidence' | 'dimensionKey'>;
      reason: string;
    }
  | {
      action: 'reject';
      dimensionKey: string;
      reason: string;
    };

export interface ReviewedOpenAssessmentDimension extends Omit<
  OpenAssessmentDimensionSuggestion,
  'confidence'
> {
  decision: 'accepted' | 'modified';
}

export interface OpenAssessmentReviewRecord {
  capabilityVersionId: string;
  decisions: OpenAssessmentReviewDecision[];
  id: string;
  questionVersionId: string;
  responseVersionId: string;
  reviewedAt: string;
  reviewedBy: OpenAssessmentReviewerReference;
  rubricId: string;
  rubricVersion: string;
}

export interface AcceptedOpenAssessmentResult {
  capabilityVersionId: string;
  dimensions: ReviewedOpenAssessmentDimension[];
  feedback: {
    improvementDimensionKey: string;
    nextAction: string;
    strengthEvidence: string;
  };
  id: string;
  reviewRecordId: string;
  rubricId: string;
  rubricVersion: string;
  version: number;
}

export interface StoredSuggestedAssessment {
  acceptedResult: AcceptedOpenAssessmentResult | null;
  actor: AssessmentActorReference;
  ageBand: OpenAssessmentAgeBand;
  authorization: SuggestedAssessmentAuthorizationSnapshot | null;
  basis: CurrentLearningBasisReference;
  capability: CapabilityVersion | null;
  consentRevision: number;
  createdAt: string;
  deduplicationKey: string;
  familySpaceId: string;
  id: string;
  inputReference: ObjectiveAssessmentInputReference;
  learningProfileId: string;
  materialId: string;
  modelRun: OpenAssessmentModelRun | null;
  question: { contentHash: string; subject: Subject; text: string; versionId: string };
  requiresProfessionalReview: boolean;
  response: { contentHash: string; text: string; versionId: string };
  review: OpenAssessmentReviewRecord | null;
  rubric: OpenAssessmentRubricSnapshot | null;
  stateRevision: number;
  status: SuggestedAssessmentStatus;
  suggestion: OpenAssessmentModelCandidate | null;
  taskType: OpenAssessmentTaskType;
  unavailableReason: SuggestedAssessmentUnavailableReason | null;
  updatedAt: string;
}

export interface SuggestedAssessmentView {
  acceptedResult: StoredSuggestedAssessment['acceptedResult'];
  aiDisclosure: 'AI 建议评价，不是官方成绩；需由有权成年人复核后才形成批改结果。';
  authorizationDecision: null | {
    containmentEpoch: number;
    id: string;
    issuedAt: string;
  };
  capabilityVersion: CapabilityVersion | null;
  citations: {
    learningBasis: Pick<
      CurrentLearningBasisReference,
      'selectionVersion' | 'sourceVersionId' | 'validityEpoch' | 'versionLabel'
    >;
    rubric: null | {
      id: string;
      name: string;
      sourceAuthority: RubricSourceAuthority;
      sourceLabel: string;
      version: string;
    };
  };
  createdAt: string;
  familySpaceId: string;
  id: string;
  learningProfileId: string;
  review: StoredSuggestedAssessment['review'];
  stateRevision: number;
  status: SuggestedAssessmentStatus;
  suggestion: OpenAssessmentModelCandidate | null;
  unavailable: null | {
    explanation: string;
    needs: string[];
    reason: SuggestedAssessmentUnavailableReason;
  };
  unavailableReason: SuggestedAssessmentUnavailableReason | null;
  updatedAt: string;
}
