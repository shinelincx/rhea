import type { JobHandler } from '@rhea/queue-adapter';
import type { ReviewCardRequestStatus, ReviewCardUnavailableReason } from '@rhea/learning-progress';

export interface ReviewCardProcessor {
  processRequest(input: { learningProfileId: string; requestId: string }): Promise<{
    id: string;
    status: ReviewCardRequestStatus;
    unavailableReason: ReviewCardUnavailableReason | null;
  }>;
}

export class ReviewCardActiveLeaseError extends Error {
  readonly code = 'REVIEW_CARD_ACTIVE_LEASE';

  constructor() {
    super('Review card is already processing under an active lease');
    this.name = 'ReviewCardActiveLeaseError';
  }
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('INVALID_REVIEW_CARD_JOB_PAYLOAD');
  }
  return value;
}

export function createReviewCardJobHandler(processor: ReviewCardProcessor): JobHandler {
  return async (input) => {
    if (input.kind !== 'review-card.generate') throw new Error('UNSUPPORTED_JOB_KIND');
    const result = await processor.processRequest({
      learningProfileId: requiredIdentifier(input.payload.learningProfileId),
      requestId: requiredIdentifier(input.payload.requestId),
    });
    if (result.status === 'generating') throw new ReviewCardActiveLeaseError();
    return {
      requestId: result.id,
      status: result.status,
      unavailableReason: result.unavailableReason,
    };
  };
}
