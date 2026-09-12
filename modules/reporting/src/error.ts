export type ReportingErrorCode = 'ACCESS_DENIED' | 'GUARDIAN_REQUIRED' | 'INPUT_INVALID';

export class ReportingError extends Error {
  constructor(
    readonly code: ReportingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReportingError';
  }
}
