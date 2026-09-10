import type { JobClient } from '@rhea/job-runtime';

import type { GeneratedLearningScheduler } from './generated-learning.provider.js';

export function createQueuedGeneratedLearningScheduler(
  jobClient: JobClient,
): GeneratedLearningScheduler {
  return {
    async schedule(request) {
      await jobClient.submit({
        deduplicationKey: request.id,
        kind: 'generated-learning.generate',
        payload: {
          learningProfileId: request.learningProfileId,
          requestId: request.id,
        },
      });
    },
  };
}
