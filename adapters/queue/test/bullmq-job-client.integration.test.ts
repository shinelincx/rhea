import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { BullMqJobClient, createProbeWorker } from '../src/index.js';

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
});
