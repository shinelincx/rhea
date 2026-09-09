export type LearningContentErrorCode =
  | 'BASIS_SELECTION_REQUIRES_GUARDIAN'
  | 'CLASSIFICATION_INVALID'
  | 'CONFIRMED_CONTENT_UNAVAILABLE'
  | 'CONFIRMED_CONTENT_ALREADY_ORGANIZED'
  | 'MATERIAL_NOT_FOUND'
  | 'SOURCE_INVALID'
  | 'UPSTREAM_INVALIDATED'
  | 'VERSION_CONFLICT';

export class LearningContentError extends Error {
  constructor(
    readonly code: LearningContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LearningContentError';
  }
}
