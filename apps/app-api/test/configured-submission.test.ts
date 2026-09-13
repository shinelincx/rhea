import { describe, expect, it } from 'vitest';

import { createConfiguredSubmission } from '../src/submission/create-configured-submission.js';

describe('configured submission boundary', () => {
  it('uses in-memory deterministic adapters only outside production', () => {
    const configured = createConfiguredSubmission({ NODE_ENV: 'test' });
    expect(configured.service).toBeDefined();
    expect(configured.shutdownResources).toEqual([]);
  });

  it('starts production with mandatory KMS-backed profile envelope encryption', async () => {
    const configured = createConfiguredSubmission({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'production',
      OBJECT_STORE_BUCKET: 'test-bucket',
      OBJECT_STORE_ENDPOINT: 'https://oss-cn-shanghai-internal.aliyuncs.com',
      OBJECT_STORE_KMS_KEY_ID: 'kms-test-key',
      KMS_ENDPOINT: 'kms.cn-shanghai.aliyuncs.com',
      REDIS_URL: 'redis://127.0.0.1:6379',
      WORKLOAD_CREDENTIALS_FILE: '/run/rhea-credentials/credentials.json',
      WORKLOAD_ROLE_ARN: 'acs:ram::123456789:role/rhea-v1-workload-api',
    });

    expect(configured.service).toBeDefined();
    expect(configured.shutdownResources).toHaveLength(2);
    await Promise.all(configured.shutdownResources.map((resource) => resource.close()));
  });
});
