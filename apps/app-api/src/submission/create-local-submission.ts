import { sharpFileInspection } from '@rhea/media-inspection-adapter';
import {
  MemoryObjectStore,
  MemoryRawAssetDeletionLog,
  MemorySubmissionStore,
  SubmissionService,
  deterministicRecognition,
} from '@rhea/submission';

import type { SubmissionScheduler } from './submission.provider.js';

export function createLocalSubmission(): {
  scheduler: SubmissionScheduler;
  service: SubmissionService;
} {
  const service = new SubmissionService({
    fileInspection: sharpFileInspection,
    objectStore: new MemoryObjectStore(),
    rawAssetDeletions: new MemoryRawAssetDeletionLog(),
    recognition: deterministicRecognition,
    store: new MemorySubmissionStore(),
  });
  return {
    scheduler: {
      schedule(job, learningProfileId) {
        setTimeout(() => void service.process(job.id, learningProfileId).catch(() => undefined), 0);
      },
    },
    service,
  };
}
