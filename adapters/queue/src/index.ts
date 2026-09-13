import {
  getJobRetryPolicy,
  isJobKind,
  type JobClient,
  type JobHandler,
  type JobKind,
  type ObservableJob,
  type SubmitJobInput,
  type SubmittedJob,
} from '@rhea/job-runtime';
import { Queue, Worker, type ConnectionOptions, type JobType } from 'bullmq';

export type { JobHandler, SubmitJobInput } from '@rhea/job-runtime';

export interface BullMqOptions {
  queueName: string;
  redisUrl: string;
}

export interface ProfileJobPurgeResult {
  inspected: number;
  removed: number;
}

function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const connection: ConnectionOptions = {
    host: url.hostname,
    port: Number.parseInt(url.port || '6379', 10),
  };

  if (url.username) {
    connection.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    connection.password = decodeURIComponent(url.password);
  }
  if (url.pathname.length > 1) {
    connection.db = Number.parseInt(url.pathname.slice(1), 10);
  }
  if (url.protocol === 'rediss:') {
    connection.tls = {};
  }

  return connection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireJobKind(value: unknown): JobKind {
  if (!isJobKind(value)) {
    throw new Error('UNSUPPORTED_JOB_KIND');
  }

  return value;
}

function requireJobInput(kindValue: unknown, payload: unknown): SubmitJobInput {
  const kind = requireJobKind(kindValue);
  if (!isRecord(payload)) throw new Error('INVALID_JOB_PAYLOAD');
  if (
    kind === 'submission.recognize' &&
    (typeof payload.processingJobId !== 'string' ||
      !payload.processingJobId.trim() ||
      typeof payload.learningProfileId !== 'string' ||
      !payload.learningProfileId.trim())
  ) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
  if (
    (kind === 'generated-learning.generate' || kind === 'review-card.generate') &&
    (typeof payload.requestId !== 'string' ||
      !payload.requestId.trim() ||
      typeof payload.learningProfileId !== 'string' ||
      !payload.learningProfileId.trim())
  ) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
  if (
    kind === 'open-assessment.generate' &&
    (typeof payload.suggestionId !== 'string' ||
      !payload.suggestionId.trim() ||
      typeof payload.learningProfileId !== 'string' ||
      !payload.learningProfileId.trim())
  ) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
  if (
    kind === 'privacy.process' &&
    (typeof payload.taskId !== 'string' || !payload.taskId.trim())
  ) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
  return kind === 'submission.recognize'
    ? {
        kind,
        payload: {
          learningProfileId: payload.learningProfileId as string,
          processingJobId: payload.processingJobId as string,
        },
      }
    : kind === 'generated-learning.generate' || kind === 'review-card.generate'
      ? {
          kind,
          payload: {
            learningProfileId: payload.learningProfileId as string,
            requestId: payload.requestId as string,
          },
        }
      : kind === 'open-assessment.generate'
        ? {
            kind,
            payload: {
              learningProfileId: payload.learningProfileId as string,
              suggestionId: payload.suggestionId as string,
            },
          }
        : kind === 'privacy.process'
          ? { kind, payload: { taskId: payload.taskId as string } }
          : { kind, payload: { outcome: payload.outcome } };
}

export class BullMqJobClient implements JobClient {
  readonly #queue: Queue;

  constructor(options: BullMqOptions) {
    this.#queue = new Queue(options.queueName, {
      connection: connectionFromUrl(options.redisUrl),
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  async get(id: string): Promise<ObservableJob | null> {
    let job = await this.#queue.getJob(id);
    if (!job) {
      return null;
    }

    const bullState = await job.getState();
    if (bullState === 'completed' || bullState === 'failed') {
      // A job can finish after getJob() reads its hash but before getState()
      // reads the terminal set. Refresh once so terminal metadata comes from
      // the same completed Redis state as the status we expose.
      job = (await this.#queue.getJob(id)) ?? job;
    }
    const status =
      bullState === 'completed'
        ? 'succeeded'
        : bullState === 'failed'
          ? 'failed'
          : bullState === 'active'
            ? 'running'
            : 'queued';

    return {
      attempts: job.attemptsMade,
      errorCode: status === 'failed' ? 'JOB_HANDLER_FAILED' : null,
      id: job.id ?? id,
      kind: requireJobKind(job.name),
      result: status === 'succeeded' && isRecord(job.returnvalue) ? job.returnvalue : null,
      status,
    };
  }

  async submit(input: SubmitJobInput): Promise<SubmittedJob> {
    if (input.deduplicationKey) {
      const existing = await this.#queue.getJob(input.deduplicationKey);
      if (existing) {
        if ((await existing.getState()) !== 'failed') {
          return { id: existing.id ?? input.deduplicationKey, status: 'queued' };
        }
        await existing.remove();
      }
    }
    const retryPolicy = getJobRetryPolicy(input.kind);
    const job = await this.#queue.add(input.kind, input.payload, {
      attempts: retryPolicy.attempts,
      backoff: {
        delay: retryPolicy.backoff.delayMs,
        type: retryPolicy.backoff.strategy,
      },
      ...(input.deduplicationKey ? { jobId: input.deduplicationKey } : {}),
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });

    if (!job.id) {
      throw new Error('BullMQ did not assign a job id');
    }

    return { id: job.id, status: 'queued' };
  }
}

export async function purgeLearningProfileJobs(
  options: { queueNames: string[]; redisUrl: string },
  learningProfileId: string,
): Promise<ProfileJobPurgeResult> {
  const result: ProfileJobPurgeResult = { inspected: 0, removed: 0 };
  const jobStates = [
    'active',
    'completed',
    'delayed',
    'failed',
    'paused',
    'prioritized',
    'waiting',
    'waiting-children',
  ] as unknown as JobType[];
  for (const queueName of new Set(options.queueNames)) {
    const queue = new Queue(queueName, { connection: connectionFromUrl(options.redisUrl) });
    try {
      const schedulers = await queue.getJobSchedulers(0, -1, true);
      result.inspected += schedulers.length;
      for (const scheduler of schedulers) {
        if (
          !isRecord(scheduler.template?.data) ||
          scheduler.template.data.learningProfileId !== learningProfileId
        )
          continue;
        if (await queue.removeJobScheduler(scheduler.key)) result.removed += 1;
      }

      const jobs = await queue.getJobs([...jobStates], 0, -1);
      result.inspected += jobs.length;
      for (const job of jobs) {
        if (!isRecord(job.data) || job.data.learningProfileId !== learningProfileId || !job.id)
          continue;
        const removed = await queue.remove(job.id, { removeChildren: true });
        if (removed === 1) {
          result.removed += 1;
          continue;
        }
        const remaining = await queue.getJob(job.id);
        if (
          remaining &&
          isRecord(remaining.data) &&
          remaining.data.learningProfileId === learningProfileId
        ) {
          throw new Error(`PROFILE_QUEUE_JOB_STILL_ACTIVE:${queueName}:${job.id}`);
        }
      }

      const [remainingJobs, remainingSchedulers] = await Promise.all([
        queue.getJobs([...jobStates], 0, -1),
        queue.getJobSchedulers(0, -1, true),
      ]);
      const remainingJob = remainingJobs.find(
        (job) => isRecord(job.data) && job.data.learningProfileId === learningProfileId,
      );
      const remainingScheduler = remainingSchedulers.find(
        (scheduler) =>
          isRecord(scheduler.template?.data) &&
          scheduler.template.data.learningProfileId === learningProfileId,
      );
      if (remainingJob || remainingScheduler) {
        throw new Error(
          `PROFILE_QUEUE_JOB_STILL_ACTIVE:${queueName}:${remainingJob?.id ?? remainingScheduler?.key}`,
        );
      }
    } finally {
      await queue.close();
    }
  }
  return result;
}

export function createJobWorker(options: BullMqOptions, handler: JobHandler): Worker {
  return new Worker(
    options.queueName,
    async (job) => {
      return handler(requireJobInput(job.name, job.data));
    },
    {
      connection: connectionFromUrl(options.redisUrl),
    },
  );
}

export function createProbeWorker(options: BullMqOptions): Worker {
  return createJobWorker(options, async (input) => {
    if (input.kind !== 'system.probe' || input.payload.outcome === 'failure') {
      throw new Error('JOB_HANDLER_FAILED');
    }

    return { message: 'processed' };
  });
}
