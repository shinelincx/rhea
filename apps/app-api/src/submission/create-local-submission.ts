import { sharpFileInspection } from '@rhea/media-inspection-adapter';
import {
  MemoryObjectStore,
  MemoryRawAssetDeletionLog,
  MemorySubmissionStore,
  SubmissionService,
  deterministicRecognition,
  type RecognitionCandidate,
} from '@rhea/submission';

import { createLocalCapabilityAuthorization } from '../quality-control/local-capability-authorization.js';
import type { SubmissionScheduler } from './submission.provider.js';

export const LOCAL_RECOGNITION_CAPABILITY: RecognitionCandidate['authorization']['capabilityVersion'] =
  {
    adapter: { id: 'deterministic-ocr', version: 'deterministic-ocr-v1' },
    artifactHash: 'a'.repeat(64),
    capabilityKey: 'ocr.recognition',
    id: 'local-deterministic-ocr-v1',
    implementedBy: 'local-development',
    kind: 'ocr',
    modelOrEngine: { id: 'deterministic-engine', version: 'engine-v1' },
    policyVersion: 'ocr-policy-v1',
    promptOrConfig: { kind: 'config', version: 'ocr-config-v1' },
    provider: { id: 'rhea-deterministic', version: 'provider-contract-v1' },
    region: 'test-local',
    registeredAt: '2026-09-01T00:00:00.000Z',
    requiredSlicePolicyVersion: 'local-ocr-quality-policy-v1',
    templateVersion: 'not-applicable-v1',
  };

export function createLocalSubmission(): {
  scheduler: SubmissionScheduler;
  service: SubmissionService;
} {
  const service = new SubmissionService({
    capabilityAuthorization: createLocalCapabilityAuthorization(LOCAL_RECOGNITION_CAPABILITY),
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
