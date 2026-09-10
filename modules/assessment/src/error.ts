export type AssessmentErrorCode =
  | 'ASSESSMENT_NOT_FOUND'
  | 'AI_PROCESSING_CONSENT_REQUIRED'
  | 'BASIS_CHANGED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'DISPUTE_NOT_FOUND'
  | 'DISPUTE_RESOLUTION_REQUIRES_GUARDIAN'
  | 'DOWNSTREAM_INELIGIBLE'
  | 'INPUT_INVALID'
  | 'PROFESSIONAL_REVIEW_UNAVAILABLE'
  | 'PROFESSIONAL_REVIEW_REQUIRED'
  | 'RULE_CONFIRMATION_REQUIRES_GUARDIAN'
  | 'SUGGESTION_NOT_REVIEWABLE'
  | 'SUGGESTION_REVIEW_REQUIRES_ADULT'
  | 'TRUSTED_INPUT_NOT_FOUND'
  | 'VERSION_CONFLICT';

export class AssessmentError extends Error {
  constructor(
    readonly code: AssessmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssessmentError';
  }
}
