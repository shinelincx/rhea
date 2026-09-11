import type { JobClient } from '@rhea/job-runtime';

import type { SuggestedAssessmentScheduler } from './assessment.provider.js';

export function createQueuedSuggestedAssessmentScheduler(
  jobClient: JobClient,
): SuggestedAssessmentScheduler {
  return {
    async schedule(request) {
      await jobClient.submit({
        deduplicationKey: request.id,
        kind: 'open-assessment.generate',
        payload: {
          learningProfileId: request.learningProfileId,
          suggestionId: request.id,
        },
      });
    },
  };
}
