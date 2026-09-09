export type FamilyAccessErrorCode =
  | 'CAPABILITY_DENIED'
  | 'CONSENT_REQUIRED'
  | 'DEVICE_INVALID'
  | 'DEVICE_PROFILE_NOT_FOUND'
  | 'FAMILY_ACCESS_DENIED'
  | 'GUARDIAN_REVERIFICATION_REQUIRED'
  | 'IDENTITY_INVALID'
  | 'INPUT_INVALID'
  | 'PIN_INVALID'
  | 'PIN_LOCKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID';

export class FamilyAccessError extends Error {
  constructor(
    readonly code: FamilyAccessErrorCode,
    message: string,
    readonly details: { remainingAttempts?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'FamilyAccessError';
  }

  get remainingAttempts(): number | undefined {
    return this.details.remainingAttempts;
  }

  get retryAfterSeconds(): number | undefined {
    return this.details.retryAfterSeconds;
  }
}
