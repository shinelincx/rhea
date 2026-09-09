export type SubmissionErrorCode =
  | 'INPUT_INVALID'
  | 'JOB_NOT_FOUND'
  | 'JOB_STATE_CONFLICT'
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_INCOMPLETE'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_TOKEN_INVALID';

export class SubmissionError extends Error {
  constructor(
    readonly code: SubmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}
