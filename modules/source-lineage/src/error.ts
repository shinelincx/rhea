export type SourceLineageErrorCode =
  | 'ARTIFACT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INPUT_INVALID'
  | 'REBUILD_CONFLICT'
  | 'SOURCE_CHANGED'
  | 'VERSION_CONFLICT';

export class SourceLineageError extends Error {
  constructor(
    readonly code: SourceLineageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceLineageError';
  }
}
