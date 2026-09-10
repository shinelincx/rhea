import { describe, expect, it } from 'vitest';

import {
  createConfiguredAiJobClient,
  createConfiguredJobClient,
} from '../src/jobs/create-configured-job-client.js';

describe('configured job client', () => {
  it('keeps local API startup usable without Redis and exposes an observable memory job', async () => {
    const client = createConfiguredJobClient({});

    const submitted = await client.submit({ kind: 'system.probe', payload: {} });

    await expect(client.get(submitted.id)).resolves.toMatchObject({
      id: submitted.id,
      status: 'queued',
    });
  });

  it('uses a distinct AI client that preserves generated-learning job identity', async () => {
    const client = createConfiguredAiJobClient({});

    const submitted = await client.submit({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
    });

    await expect(client.get(submitted.id)).resolves.toMatchObject({
      id: submitted.id,
      kind: 'generated-learning.generate',
      status: 'queued',
    });
  });

  it('fails production startup when Redis is missing instead of losing queued work in memory', () => {
    expect(() => createConfiguredJobClient({ NODE_ENV: 'production' })).toThrow(
      'REDIS_URL is required in production',
    );
    expect(() => createConfiguredAiJobClient({ NODE_ENV: 'production' })).toThrow(
      'REDIS_URL is required in production',
    );
  });
});
