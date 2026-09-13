export type PrivacyLifecycleErrorCode =
  'PRIVACY_INPUT_INVALID' | 'PRIVACY_TASK_NOT_FOUND' | 'PRIVACY_TASK_NOT_READY';

export class PrivacyLifecycleError extends Error {
  constructor(
    readonly code: PrivacyLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PrivacyLifecycleError';
  }
}
