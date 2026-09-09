import { describe, expect, it } from 'vitest';

import { createConfiguredJobClient } from '../src/jobs/create-configured-job-client.js';

describe('configured job client', () => {
  it('keeps local API startup usable without Redis and exposes an observable memory job', async () => {
    const client = createConfiguredJobClient({});

    const submitted = await client.submit({ kind: 'system.probe', payload: {} });

    await expect(client.get(submitted.id)).resolves.toMatchObject({
      id: submitted.id,
      status: 'queued',
    });
  });
});
