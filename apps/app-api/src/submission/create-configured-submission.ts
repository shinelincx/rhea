import { sharpFileInspection } from '@rhea/media-inspection-adapter';
import { createS3ObjectStore } from '@rhea/object-storage-adapter';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { createPostgresSubmissionStore } from '@rhea/postgres-submission';
import {
  PostgresProfileEnvelopeObjectStore,
  ShanghaiKmsProfileKeyWrapper,
} from '@rhea/postgres-privacy';
import { QualityControlService } from '@rhea/quality-control';
import {
  SubmissionService,
  deterministicRecognition,
  type RecognitionPort,
} from '@rhea/submission';
import { GovernedHttpClient, ShanghaiOcrRecognitionAdapter } from '@rhea/china-provider-adapters';
import type { ProviderGovernanceService } from '@rhea/provider-governance';

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
  governance?: ProviderGovernanceService,
): ConfiguredSubmission {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production submissions');
    }
    return { ...createLocalSubmission(), shutdownResources: [] };
  }
  const { pool, store } = createPostgresSubmissionStore(environment.DATABASE_URL);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(pool));
  const kmsKeyId =
    environment.NODE_ENV === 'production'
      ? required(environment, 'OBJECT_STORE_KMS_KEY_ID')
      : (environment.OBJECT_STORE_KMS_KEY_ID ?? 'local-kms-key');
  const keyWrapper =
    environment.NODE_ENV === 'production'
      ? new ShanghaiKmsProfileKeyWrapper({
          credentialsFile: required(environment, 'WORKLOAD_CREDENTIALS_FILE'),
          ...(environment.KMS_ENDPOINT ? { endpoint: environment.KMS_ENDPOINT } : {}),
          expectedRoleArn: required(environment, 'WORKLOAD_ROLE_ARN'),
          regionId: 'cn-shanghai',
        })
      : (environment.PROFILE_ENVELOPE_KEK ?? 'local-profile-envelope-kek-at-least-32-bytes');
  const objectCredentials =
    environment.NODE_ENV === 'production'
      ? {
          credentialsFile: required(environment, 'WORKLOAD_CREDENTIALS_FILE'),
          expectedRoleArn: required(environment, 'WORKLOAD_ROLE_ARN'),
        }
      : {
          accessKeyId: required(environment, 'OBJECT_STORE_ACCESS_KEY'),
          secretAccessKey: required(environment, 'OBJECT_STORE_SECRET_KEY'),
        };
  const objectStorage = createS3ObjectStore({
    bucket: required(environment, 'OBJECT_STORE_BUCKET'),
    endpoint: required(environment, 'OBJECT_STORE_ENDPOINT'),
    forcePathStyle: environment.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
    kmsKeyId,
    region: environment.OBJECT_STORE_REGION ?? 'cn-shanghai',
    ...objectCredentials,
  });
  const service = new SubmissionService({
    capabilityAuthorization: qualityControl,
    fileInspection: sharpFileInspection,
    objectStore: new PostgresProfileEnvelopeObjectStore(
      pool,
      objectStorage.store,
      keyWrapper,
      kmsKeyId,
    ),
    rawAssetDeletions: store,
    recognition:
      environment.NODE_ENV === 'production'
        ? governance &&
          environment.OCR_URL &&
          environment.OCR_TOKEN &&
          environment.OCR_CAPABILITY_VERSION_ID
          ? new ShanghaiOcrRecognitionAdapter(
              new GovernedHttpClient({
                authorizationToken: environment.OCR_TOKEN,
                capabilityVersionId: environment.OCR_CAPABILITY_VERSION_ID,
                dataCategories: ['source_image'],
                governance,
                purpose: 'shanghai_ocr_recognition',
                url: environment.OCR_URL,
              }),
            )
          : unavailableRecognition
        : deterministicRecognition,
    store,
  });
  return {
    scheduler: {
      // Persistent requests are dispatched only by the transactional outbox relay.
      // Keeping the API side effect-free closes the freeze -> cache purge enqueue race.
      async schedule() {},
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
