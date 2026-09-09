import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createMemoryJobRuntime } from '@rhea/job-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('Background job HTTP workflow', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('accepts work, lets a worker consume it, and exposes the final status', async () => {
    const runtime = createMemoryJobRuntime();
    app = await createApp({ dependencyProbes: [], jobClient: runtime });
    await app.init();

    const accepted = await app.inject({
      method: 'POST',
      payload: { outcome: 'success' },
      url: '/internal/probe-jobs',
    });
    expect(accepted.statusCode).toBe(202);
    const submitted = accepted.json<{ data: { id: string; status: string } }>();
    expect(submitted.data.status).toBe('queued');

    await runtime.workNext(async () => ({ message: 'processed' }));

    const observed = await app.inject({
      method: 'GET',
      url: `/internal/probe-jobs/${submitted.data.id}`,
    });
    expect(observed.statusCode).toBe(200);
    expect(observed.json()).toEqual({
      data: {
        attempts: 1,
        errorCode: null,
        id: submitted.data.id,
        kind: 'system.probe',
        result: { message: 'processed' },
        status: 'succeeded',
      },
    });
  });
});
