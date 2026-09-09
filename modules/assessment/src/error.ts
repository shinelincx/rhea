export type AssessmentErrorCode =
  | 'ASSESSMENT_NOT_FOUND'
  | 'BASIS_CHANGED'
  | 'DISPUTE_NOT_FOUND'
  | 'DISPUTE_RESOLUTION_REQUIRES_GUARDIAN'
  | 'DOWNSTREAM_INELIGIBLE'
  | 'INPUT_INVALID'
  | 'PROFESSIONAL_REVIEW_REQUIRED'
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
