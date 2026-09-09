import { describe, expect, it } from 'vitest';

import { createMemoryJobRuntime } from '../src/index.js';

describe('Background job runtime interface', () => {
  it('makes a successful worker result observable', async () => {
    const runtime = createMemoryJobRuntime();
    const job = await runtime.submit({ kind: 'system.probe', payload: { outcome: 'success' } });

    await runtime.workNext(async () => ({ message: 'processed' }));

    expect(await runtime.get(job.id)).toEqual({
      attempts: 1,
      errorCode: null,
      id: job.id,
      kind: 'system.probe',
      result: { message: 'processed' },
      status: 'succeeded',
    });
  });

  it('makes a failed worker result observable without leaking an exception message', async () => {
    const runtime = createMemoryJobRuntime();
    const job = await runtime.submit({ kind: 'system.probe', payload: { outcome: 'failure' } });

    await runtime.workNext(async () => {
      throw new Error('contains private input');
    });

    expect(await runtime.get(job.id)).toEqual({
      attempts: 1,
      errorCode: 'JOB_HANDLER_FAILED',
      id: job.id,
      kind: 'system.probe',
      result: null,
      status: 'failed',
    });
  });
});
