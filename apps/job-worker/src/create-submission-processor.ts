import { GovernedHttpClient, ShanghaiOcrRecognitionAdapter } from '@rhea/china-provider-adapters';
import { sharpFileInspection } from '@rhea/media-inspection-adapter';
import { createS3ObjectStore } from '@rhea/object-storage-adapter';
import {
  PostgresProfileEnvelopeObjectStore,
  ShanghaiKmsProfileKeyWrapper,
} from '@rhea/postgres-privacy';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { createPostgresSubmissionStore } from '@rhea/postgres-submission';
import type { ProviderGovernanceService } from '@rhea/provider-governance';
import { QualityControlService } from '@rhea/quality-control';
import type { JobHandler } from '@rhea/queue-adapter';
import { SubmissionService, type RecognitionPort } from '@rhea/submission';

const unavailableRecognition: RecognitionPort = {
  async recognize() {
    throw new Error('RECOGNITION_PROVIDER_UNAVAILABLE');
  },
};

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for the submission worker`);
  return value;
}

export function createConfiguredSubmissionProcessor(
  environment: Record<string, string | undefined>,
  governance: ProviderGovernanceService,
): { handler: JobHandler; shutdownResources: Array<{ close(): Promise<void> }> } {
  const databaseUrl = required(environment, 'DATABASE_URL');
  const kmsKeyId = required(environment, 'OBJECT_STORE_KMS_KEY_ID');
  const { pool, store } = createPostgresSubmissionStore(databaseUrl);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(pool));
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
      new ShanghaiKmsProfileKeyWrapper({
        credentialsFile: required(environment, 'WORKLOAD_CREDENTIALS_FILE'),
        ...(environment.KMS_ENDPOINT ? { endpoint: environment.KMS_ENDPOINT } : {}),
        expectedRoleArn: required(environment, 'WORKLOAD_ROLE_ARN'),
        regionId: 'cn-shanghai',
      }),
      kmsKeyId,
    ),
    rawAssetDeletions: store,
    recognition:
      environment.OCR_URL && environment.OCR_TOKEN && environment.OCR_CAPABILITY_VERSION_ID
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
        : unavailableRecognition,
    store,
  });
  const handler: JobHandler = async (input) => {
    if (input.kind !== 'submission.recognize') throw new Error('JOB_KIND_UNSUPPORTED');
    const result = await service.process(
      input.payload.processingJobId,
      input.payload.learningProfileId,
    );
    return { processingJobId: result.id, status: result.status };
  };
  return {
    handler,
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
