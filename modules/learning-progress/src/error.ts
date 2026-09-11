export type LearningProgressErrorCode =
  | 'CLASSIFICATION_INVALID'
  | 'CORRECTION_NOT_AVAILABLE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INPUT_INVALID'
  | 'REASON_REVISION_INVALID'
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
