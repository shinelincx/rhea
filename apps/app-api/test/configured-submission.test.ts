import { describe, expect, it } from 'vitest';

import { createConfiguredSubmission } from '../src/submission/create-configured-submission.js';

describe('configured submission boundary', () => {
  it('uses in-memory deterministic adapters only outside production', () => {
    const configured = createConfiguredSubmission({ NODE_ENV: 'test' });
    expect(configured.service).toBeDefined();
    expect(configured.shutdownResources).toEqual([]);
  });

  it('starts production in recoverable quality-governed mode without a provider default', async () => {
    const configured = createConfiguredSubmission({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'production',
      OBJECT_STORE_ACCESS_KEY: 'test-access-key',
      OBJECT_STORE_BUCKET: 'test-bucket',
      OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000',
      OBJECT_STORE_SECRET_KEY: 'test-secret-key',
    });

    expect(configured.service).toBeDefined();
    expect(configured.shutdownResources).toHaveLength(2);
    await Promise.all(configured.shutdownResources.map((resource) => resource.close()));
  });
});
