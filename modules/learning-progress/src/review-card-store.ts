import type {
  ReviewCardAttempt,
  ReviewCardCheck,
  ReviewCardModelRun,
  ReviewCardSchedule,
  ShortReviewSession,
  StoredReviewCard,
  StoredReviewCardRequest,
} from './review-card-types.js';

export type ReviewCardCompletionResult =
  | 'capability_contained'
  | 'capability_unavailable'
  | 'completed'
  | 'conflict'
  | 'consent_withdrawn'
  | 'source_changed';

export interface ReviewCardStore {
  completeReviewCardRequest(input: {
    card: StoredReviewCard;
    expectedStateRevision: number;
    modelRuns: ReviewCardModelRun[];
    requestId: string;
  }): Promise<ReviewCardCompletionResult>;
  createReviewCardRequest(request: StoredReviewCardRequest): Promise<boolean>;
  createShortReviewSession(session: ShortReviewSession): Promise<boolean>;
  failReviewCardRequest(input: {
    expectedStateRevision: number;
    latestChecks: ReviewCardCheck[];
    learningProfileId: string;
    modelRuns: ReviewCardModelRun[];
    reason: NonNullable<StoredReviewCardRequest['unavailableReason']>;
    requestId: string;
    updatedAt: string;
  }): Promise<boolean>;
  findReviewCardById(id: string, learningProfileId: string): Promise<StoredReviewCard | null>;
  findReviewCardRequestById(
    id: string,
    learningProfileId: string,
  ): Promise<StoredReviewCardRequest | null>;
  findReviewCardRequestByIdempotencyKey(
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<StoredReviewCardRequest | null>;
  findReviewAttemptByIdempotencyKey(
    cardId: string,
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<ReviewCardAttempt | null>;
  findShortReviewSession(id: string, learningProfileId: string): Promise<ShortReviewSession | null>;
  invalidateReviewCard(input: {
    expectedStateRevision: number;
    learningProfileId: string;
    reason:
      'CAPABILITY_CONTAINED' | 'CAPABILITY_UNAVAILABLE' | 'CONSENT_WITHDRAWN' | 'SOURCE_CHANGED';
    requestId: string;
    updatedAt: string;
  }): Promise<boolean>;
  listActiveReviewCards(learningProfileId: string): Promise<StoredReviewCard[]>;
  markReviewCardGenerating(input: {
    expectedStateRevision: number;
    leaseExpiresAt: string;
    learningProfileId: string;
    requestId: string;
    updatedAt: string;
  }): Promise<boolean>;
  recordReviewAttempt(input: {
    attempt: ReviewCardAttempt;
    expectedSchedule: ReviewCardSchedule;
    learningProfileId: string;
  }): Promise<boolean>;
}
