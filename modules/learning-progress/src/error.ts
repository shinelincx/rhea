export type LearningProgressErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'CLASSIFICATION_INVALID'
  | 'CONSENT_REQUIRED'
  | 'CORRECTION_NOT_AVAILABLE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INPUT_INVALID'
  | 'REASON_REVISION_INVALID'
  | 'REVIEW_CARD_NOT_FOUND'
  | 'REVIEW_CARD_NOT_READY'
  | 'REVIEW_SESSION_NOT_FOUND'
  | 'SOURCE_INELIGIBLE'
  | 'VERSION_CONFLICT'
  | 'WRONG_ITEM_NOT_FOUND';

export class LearningProgressError extends Error {
  constructor(
    readonly code: LearningProgressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LearningProgressError';
  }
}
