export type GeneratedLearningErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'GENERATION_NOT_READY'
  | 'GENERATION_REQUEST_NOT_FOUND'
  | 'INPUT_INVALID'
  | 'SOURCE_UNAVAILABLE'
  | 'VERSION_CONFLICT';

export class GeneratedLearningError extends Error {
  constructor(
    readonly code: GeneratedLearningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeneratedLearningError';
  }
}
