export type ChallengeErrorCode =
  | 'ACCESS_DENIED'
  | 'CHALLENGE_CONSENT_REQUIRED'
  | 'CHALLENGE_NOT_ACTIVE'
  | 'CHALLENGE_NOT_FOUND'
  | 'GENERATED_PACK_INVALID'
  | 'GRADE_MISMATCH'
  | 'GRADE_REQUIRED'
  | 'INPUT_INVALID'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_EXPIRED'
  | 'INVITE_INVALID'
  | 'INVITE_SELF_USE'
  | 'ITEM_ALREADY_ANSWERED'
  | 'ITEM_NOT_FOUND'
  | 'PARTNER_RELATION_INACTIVE'
  | 'PARTNER_RELATION_NOT_FOUND'
  | 'WRITE_CONFLICT';

export class ChallengeError extends Error {
  constructor(
    readonly code: ChallengeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChallengeError';
  }
}
