import { sharpFileInspection } from '@rhea/media-inspection-adapter';
import { createS3ObjectStore } from '@rhea/object-storage-adapter';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { createPostgresSubmissionStore } from '@rhea/postgres-submission';
import { QualityControlService } from '@rhea/quality-control';
import {
  SubmissionService,
  deterministicRecognition,
  type RecognitionPort,
} from '@rhea/submission';

import { createLocalSubmission } from './create-local-submission.js';
import type { SubmissionScheduler } from './submission.provider.js';

const unavailableRecognition: RecognitionPort = {
  async recognize() {
    throw new Error('RECOGNITION_PROVIDER_UNAVAILABLE');
  },
};

export interface ConfiguredSubmission {
  scheduler: SubmissionScheduler;
  service: SubmissionService;
  shutdownResources: Array<{ close(): Promise<void> }>;
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required when DATABASE_URL enables persistent submissions`);
  }
  return value;
}

export function createConfiguredSubmission(
  environment: Record<string, string | undefined>,
): ConfiguredSubmission {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production submissions');
    }
    return { ...createLocalSubmission(), shutdownResources: [] };
  }
  const { pool, store } = createPostgresSubmissionStore(environment.DATABASE_URL);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(pool));
  const objectStorage = createS3ObjectStore({
    accessKeyId: required(environment, 'OBJECT_STORE_ACCESS_KEY'),
    bucket: required(environment, 'OBJECT_STORE_BUCKET'),
    endpoint: required(environment, 'OBJECT_STORE_ENDPOINT'),
    forcePathStyle: environment.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
    ...(environment.OBJECT_STORE_KMS_KEY_ID
      ? { kmsKeyId: environment.OBJECT_STORE_KMS_KEY_ID }
      : {}),
    region: environment.OBJECT_STORE_REGION ?? 'cn-shanghai',
    secretAccessKey: required(environment, 'OBJECT_STORE_SECRET_KEY'),
  });
  const service = new SubmissionService({
    capabilityAuthorization: qualityControl,
    fileInspection: sharpFileInspection,
    objectStore: objectStorage.store,
    rawAssetDeletions: store,
    recognition:
      environment.NODE_ENV === 'production' ? unavailableRecognition : deterministicRecognition,
    store,
  });
  return {
    scheduler: {
      schedule(job, learningProfileId) {
        setTimeout(() => void service.process(job.id, learningProfileId).catch(() => undefined), 0);
      },
    },
    service,
    shutdownResources: [
      { close: () => pool.end() },
      {
        async close() {
          objectStorage.client.destroy();
        },
      },
    ],
  };
}
