export type SafetyEscalationErrorCode =
  | 'SAFETY_CASE_NOT_FOUND'
  | 'SAFETY_INPUT_INVALID'
  | 'SUPPORT_ACCESS_DENIED'
  | 'SUPPORT_GRANT_NOT_FOUND';

export class SafetyEscalationError extends Error {
  constructor(
    readonly code: SafetyEscalationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafetyEscalationError';
  }
}
