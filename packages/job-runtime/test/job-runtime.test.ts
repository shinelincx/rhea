import { describe, expect, it } from 'vitest';

import { createMemoryJobRuntime, getJobRetryPolicy, isJobKind } from '../src/index.js';

describe('Background job runtime interface', () => {
  it('recognizes only supported job kinds', () => {
    expect(isJobKind('system.probe')).toBe(true);
    expect(isJobKind('generated-learning.generate')).toBe(true);
    expect(isJobKind('generated-learning.unknown')).toBe(false);
  });

  it('keeps generated-learning retries beyond the processing lease without slowing probes', () => {
    expect(getJobRetryPolicy('generated-learning.generate')).toEqual({
      attempts: 4,
      backoff: { delayMs: 65_000, strategy: 'fixed' },
    });
    expect(getJobRetryPolicy('system.probe')).toEqual({
      attempts: 3,
      backoff: { delayMs: 250, strategy: 'exponential' },
    });
  });

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

  it('preserves the generated-learning job kind through processing and observation', async () => {
    const runtime = createMemoryJobRuntime();
    const job = await runtime.submit({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
    });

    await runtime.workNext(async (input) => ({ processedKind: input.kind }));

    expect(await runtime.get(job.id)).toMatchObject({
      kind: 'generated-learning.generate',
      result: { processedKind: 'generated-learning.generate' },
      status: 'succeeded',
    });
  });

  it('deduplicates repeated submissions without adding duplicate work', async () => {
    const runtime = createMemoryJobRuntime();
    const input = {
      deduplicationKey: 'generation-request-1',
      kind: 'generated-learning.generate' as const,
      payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
    };

    const first = await runtime.submit(input);
    const replay = await runtime.submit(input);
    let processed = 0;
    await runtime.workNext(async () => {
      processed += 1;
      return {};
    });
    await runtime.workNext(async () => {
      processed += 1;
      return {};
    });

    expect(replay.id).toBe(first.id);
    expect(processed).toBe(1);
  });

  it('allows an explicit resubmission after a deduplicated job failed', async () => {
    const runtime = createMemoryJobRuntime();
    const input = {
      deduplicationKey: 'generation-request-retry',
      kind: 'generated-learning.generate' as const,
      payload: { learningProfileId: 'profile-1', requestId: 'request-retry' },
    };
    const failed = await runtime.submit(input);
    await runtime.workNext(async () => {
      throw new Error('temporary worker failure');
    });

    const retried = await runtime.submit(input);
    await runtime.workNext(async () => ({ status: 'ready' }));

    expect(retried.id).not.toBe(failed.id);
    await expect(runtime.get(retried.id)).resolves.toMatchObject({ status: 'succeeded' });
  });
});
