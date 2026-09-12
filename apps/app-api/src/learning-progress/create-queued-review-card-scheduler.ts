import type { JobClient } from '@rhea/job-runtime';

import type { ReviewCardScheduler } from './learning-progress.provider.js';

export function createQueuedReviewCardScheduler(jobClient: JobClient): ReviewCardScheduler {
  return {
    async schedule(request) {
      await jobClient.submit({
        deduplicationKey: request.id,
        kind: 'review-card.generate',
        payload: { learningProfileId: request.learningProfileId, requestId: request.id },
      });
    },
  };
}
