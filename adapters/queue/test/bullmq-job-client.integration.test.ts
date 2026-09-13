import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import { Queue, type JobType } from 'bullmq';

import {
  BullMqJobClient,
  createJobWorker,
  createProbeWorker,
  purgeLearningProfileJobs,
} from '../src/index.js';

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

  it('removes retained and waiting jobs for only the erased learning profile', async () => {
    const queueName = `rhea-test-${randomUUID()}`;
    const client = new BullMqJobClient({ queueName, redisUrl: process.env.REDIS_URL! });
    resources.push(client);
    const erased = await client.submit({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-erased', requestId: 'generation-erased' },
    });
    const retained = await client.submit({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-retained', requestId: 'generation-retained' },
    });

    await expect(
      purgeLearningProfileJobs(
        { queueNames: [queueName], redisUrl: process.env.REDIS_URL! },
        'profile-erased',
      ),
    ).resolves.toMatchObject({ removed: 1 });
    await expect(client.get(erased.id)).resolves.toBeNull();
    await expect(client.get(retained.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('removes paused jobs and recurring schedulers for only the erased profile', async () => {
    const queueName = `rhea-test-${randomUUID()}`;
    const redisUrl = new URL(process.env.REDIS_URL!);
    const queue = new Queue(queueName, {
      connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) },
    });
    resources.push(queue);
    await queue.pause();
    await queue.add('generated-learning.generate', {
      learningProfileId: 'profile-erased',
      requestId: 'paused-erased',
    });
    await queue.upsertJobScheduler(
      'erased-scheduler',
      { every: 60_000 },
      {
        data: { learningProfileId: 'profile-erased', requestId: 'recurring-erased' },
        name: 'generated-learning.generate',
      },
    );
    await queue.upsertJobScheduler(
      'retained-scheduler',
      { every: 60_000 },
      {
        data: { learningProfileId: 'profile-retained', requestId: 'recurring-retained' },
        name: 'generated-learning.generate',
      },
    );

    await purgeLearningProfileJobs(
      { queueNames: [queueName], redisUrl: process.env.REDIS_URL! },
      'profile-erased',
    );

    const paused = await queue.getJobs(['paused'] as unknown as JobType[], 0, -1);
    expect(paused.some(({ data }) => data.learningProfileId === 'profile-erased')).toBe(false);
    const schedulers = await queue.getJobSchedulers(0, -1, true);
    expect(schedulers.map(({ key }) => key)).toContain('retained-scheduler');
    expect(schedulers.map(({ key }) => key)).not.toContain('erased-scheduler');
  });
});
