import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { BullMqJobClient, createJobWorker, createProbeWorker } from '../src/index.js';

const describeWithRedis = process.env.REDIS_URL ? describe : describe.skip;

describeWithRedis('BullMQ job adapter interface', () => {
  const resources: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((resource) => resource.close()));
  });

  it('publishes jobs and exposes safe success and failure results', async () => {
    const queueName = `rhea-test-${randomUUID()}`;
    const client = new BullMqJobClient({ queueName, redisUrl: process.env.REDIS_URL! });
    const worker = createProbeWorker({ queueName, redisUrl: process.env.REDIS_URL! });
    resources.push(client, worker);

    const submitted = await client.submit({
      kind: 'system.probe',
      payload: { outcome: 'success' },
    });

    const deadline = Date.now() + 5_000;
    let observed = await client.get(submitted.id);
    while (observed?.status !== 'succeeded' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      observed = await client.get(submitted.id);
    }

    expect(observed).toMatchObject({
      errorCode: null,
      id: submitted.id,
      result: { message: 'processed' },
      status: 'succeeded',
    });

    const failed = await client.submit({
      kind: 'system.probe',
      payload: { outcome: 'failure' },
    });
    const failureDeadline = Date.now() + 5_000;
    let failedObservation = await client.get(failed.id);
    while (failedObservation?.status !== 'failed' && Date.now() < failureDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      failedObservation = await client.get(failed.id);
    }

    expect(failedObservation).toMatchObject({
      attempts: 3,
      errorCode: 'JOB_HANDLER_FAILED',
      id: failed.id,
      result: null,
      status: 'failed',
    });
  });

  it('exposes the validated generated-learning kind instead of substituting a probe kind', async () => {
    const queueName = `rhea-test-${randomUUID()}`;
    const client = new BullMqJobClient({ queueName, redisUrl: process.env.REDIS_URL! });
    const worker = createJobWorker(
      { queueName, redisUrl: process.env.REDIS_URL! },
      async (input) => ({ processedKind: input.kind }),
    );
    resources.push(client, worker);

    const submitted = await client.submit({
      deduplicationKey: 'generation-1',
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
    });
    const replay = await client.submit({
      deduplicationKey: 'generation-1',
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
    });
    expect(replay.id).toBe(submitted.id);

    const deadline = Date.now() + 5_000;
    let observed = await client.get(submitted.id);
    while (observed?.status !== 'succeeded' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      observed = await client.get(submitted.id);
    }

    expect(observed).toMatchObject({
      kind: 'generated-learning.generate',
      result: { processedKind: 'generated-learning.generate' },
      status: 'succeeded',
    });
  });

  it('keeps a retryable generated-learning delivery delayed beyond the active lease window', async () => {
    const queueName = `rhea-test-${randomUUID()}`;
    const client = new BullMqJobClient({ queueName, redisUrl: process.env.REDIS_URL! });
    let handled = 0;
    let firstAttempt!: () => void;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      firstAttempt = resolve;
    });
    const worker = createJobWorker({ queueName, redisUrl: process.env.REDIS_URL! }, async () => {
      handled += 1;
      firstAttempt();
      throw new Error('GENERATED_LEARNING_ACTIVE_LEASE');
    });
    resources.push(client, worker);

    const submitted = await client.submit({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'generation-retry-1' },
    });
    await firstAttemptStarted;

    const deadline = Date.now() + 2_000;
    let observed = await client.get(submitted.id);
    while (observed?.attempts !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      observed = await client.get(submitted.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(observed).toMatchObject({ attempts: 1, kind: 'generated-learning.generate' });
    expect(handled).toBe(1);
    expect((await client.get(submitted.id))?.status).toBe('queued');
  });
});
