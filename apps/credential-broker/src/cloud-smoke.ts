import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

import { DecryptRequest, EncryptRequest } from '@alicloud/kms20160120';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';
import { createS3ObjectStore } from '@rhea/object-storage-adapter';
import { FileWorkloadCredentialsProvider } from '@rhea/workload-credentials-adapter';

const require = createRequire(import.meta.url);
const CredentialConstructor = (
  require('@alicloud/credentials') as {
    default: typeof import('@alicloud/credentials').default;
  }
).default;
const KmsClientConstructor = (
  require('@alicloud/kms20160120') as {
    default: typeof import('@alicloud/kms20160120').default;
  }
).default;

interface SmokeWorkload {
  credentialsFile: string;
  roleArn: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required for the cloud credential smoke test');
  return value;
}

function workload(name: 'AI' | 'API' | 'SAFETY'): SmokeWorkload {
  return {
    credentialsFile: required('CREDENTIAL_BROKER_' + name + '_OUTPUT'),
    roleArn: required('CREDENTIAL_BROKER_' + name + '_ROLE_ARN'),
  };
}

function kmsClient(input: SmokeWorkload) {
  const credential = new CredentialConstructor(
    null,
    new FileWorkloadCredentialsProvider(input.credentialsFile, input.roleArn),
  );
  return new KmsClientConstructor(
    new OpenApiConfig({
      connectTimeout: 10_000,
      credential,
      ...(process.env.KMS_ENDPOINT ? { endpoint: process.env.KMS_ENDPOINT } : {}),
      protocol: 'HTTPS',
      readTimeout: 10_000,
      regionId: 'cn-shanghai',
    }),
  );
}

async function verifyKmsRoundTrip(client: ReturnType<typeof kmsClient>, keyId: string) {
  const plaintext = randomBytes(32);
  const encrypted = await client.encrypt(
    new EncryptRequest({ keyId, plaintext: plaintext.toString('base64') }),
  );
  if (!encrypted.body?.ciphertextBlob) throw new Error('CLOUD_SMOKE_KMS_ENCRYPT_INVALID');
  const decrypted = await client.decrypt(
    new DecryptRequest({ ciphertextBlob: encrypted.body.ciphertextBlob }),
  );
  if (!decrypted.body?.plaintext) throw new Error('CLOUD_SMOKE_KMS_DECRYPT_INVALID');
  const actual = Buffer.from(decrypted.body.plaintext, 'base64');
  if (actual.byteLength !== plaintext.byteLength || !timingSafeEqual(actual, plaintext)) {
    throw new Error('CLOUD_SMOKE_KMS_ROUND_TRIP_FAILED');
  }
  return encrypted.body.ciphertextBlob;
}

async function verifyKmsEncrypt(client: ReturnType<typeof kmsClient>, keyId: string) {
  const encrypted = await client.encrypt(
    new EncryptRequest({ keyId, plaintext: randomBytes(32).toString('base64') }),
  );
  if (!encrypted.body?.ciphertextBlob) throw new Error('CLOUD_SMOKE_KMS_ENCRYPT_INVALID');
}

function objectStore(
  input: SmokeWorkload,
  options: { bucket: string; endpoint: string; kmsKeyId?: string },
) {
  return createS3ObjectStore({
    bucket: options.bucket,
    credentialsFile: input.credentialsFile,
    endpoint: options.endpoint,
    expectedRoleArn: input.roleArn,
    ...(options.kmsKeyId ? { kmsKeyId: options.kmsKeyId } : {}),
    region: 'cn-shanghai',
  });
}

async function expectDenied(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const code =
      error && typeof error === 'object'
        ? String(
            (error as { Code?: unknown; code?: unknown; name?: unknown }).Code ??
              (error as { code?: unknown }).code ??
              (error as { name?: unknown }).name ??
              '',
          )
        : '';
    if (/AccessDenied|Forbidden|NoPermission/i.test(code)) return;
    throw error;
  }
  throw new Error('CLOUD_SMOKE_EXPECTED_ACCESS_DENIED');
}

export async function runCloudCredentialSmoke() {
  if (required('OBJECT_STORE_REGION') !== 'cn-shanghai') {
    throw new Error('Cloud credential smoke test is restricted to cn-shanghai');
  }
  const endpoint = required('OBJECT_STORE_ENDPOINT');
  const bucket = required('OBJECT_STORE_BUCKET');
  const learningKeyId = required('OBJECT_STORE_KMS_KEY_ID');
  const safetyKeyId = required('SAFETY_KMS_KEY_ID');
  const api = workload('API');
  const ai = workload('AI');
  const safety = workload('SAFETY');
  const apiStorage = objectStore(api, { bucket, endpoint, kmsKeyId: learningKeyId });
  const aiStorage = objectStore(ai, { bucket, endpoint, kmsKeyId: learningKeyId });
  const safetyStorage = objectStore(safety, { bucket, endpoint });
  const prefix = 'ingest-temporary/credential-smoke/' + randomUUID();
  const apiKey = prefix + '/api';
  const aiKey = prefix + '/ai';
  try {
    await apiStorage.store.put(apiKey, randomBytes(32));
    if (!(await apiStorage.store.get(apiKey))) throw new Error('CLOUD_SMOKE_API_OSS_GET_FAILED');
    await aiStorage.store.put(aiKey, randomBytes(32));
    if (!(await aiStorage.store.get(aiKey))) throw new Error('CLOUD_SMOKE_AI_OSS_GET_FAILED');
    await safetyStorage.store.delete(apiKey);
    if (await apiStorage.store.get(apiKey)) throw new Error('CLOUD_SMOKE_PRIVACY_DELETE_FAILED');
    await aiStorage.store.delete(aiKey);

    const apiKms = kmsClient(api);
    const aiKms = kmsClient(ai);
    const safetyKms = kmsClient(safety);
    const learningCiphertext = await verifyKmsRoundTrip(apiKms, learningKeyId);
    await verifyKmsRoundTrip(aiKms, learningKeyId);
    const safetyCiphertext = await verifyKmsRoundTrip(apiKms, safetyKeyId);
    await verifyKmsEncrypt(aiKms, safetyKeyId);
    await verifyKmsEncrypt(safetyKms, safetyKeyId);
    const safetyDecryption = await safetyKms.decrypt(
      new DecryptRequest({ ciphertextBlob: learningCiphertext }),
    );
    if (!safetyDecryption.body?.plaintext) {
      throw new Error('CLOUD_SMOKE_PRIVACY_EXPORT_KMS_DECRYPT_FAILED');
    }
    await expectDenied(() =>
      aiKms.decrypt(new DecryptRequest({ ciphertextBlob: safetyCiphertext })),
    );
    await expectDenied(() =>
      safetyKms.decrypt(new DecryptRequest({ ciphertextBlob: safetyCiphertext })),
    );
    await expectDenied(() => safetyStorage.store.put(prefix + '/forbidden', randomBytes(8)));
    return {
      checks: [
        'api_oss_sse_kms_put_get',
        'ai_oss_sse_kms_put_get',
        'privacy_oss_delete',
        'api_learning_kms_round_trip',
        'ai_learning_kms_round_trip',
        'api_safety_mapping_kms_round_trip',
        'ai_safety_kms_encrypt',
        'safety_worker_safety_kms_encrypt',
        'privacy_export_learning_kms_decrypt',
        'ai_safety_kms_decrypt_denied',
        'safety_worker_safety_kms_decrypt_denied',
        'safety_oss_put_denied',
      ],
      event: 'cloud_workload_credentials_verified',
      passed: true,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    await Promise.allSettled([
      apiStorage.store.delete(apiKey),
      aiStorage.store.delete(aiKey),
      safetyStorage.store.delete(apiKey),
      safetyStorage.store.delete(aiKey),
    ]);
    apiStorage.client.destroy();
    aiStorage.client.destroy();
    safetyStorage.client.destroy();
  }
}
