import type { JobClient } from '@rhea/job-runtime';

import type { PrivacyTaskScheduler } from './privacy.provider.js';

export function createQueuedPrivacyTaskScheduler(jobClient: JobClient): PrivacyTaskScheduler {
  return {
    async schedule(taskId) {
      await jobClient.submit({
        deduplicationKey: taskId,
        kind: 'privacy.process',
        payload: { taskId },
      });
    },
  };
}
