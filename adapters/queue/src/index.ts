import type { JobClient, ObservableJob, SubmitJobInput, SubmittedJob } from '@rhea/job-runtime';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export interface BullMqOptions {
  queueName: string;
  redisUrl: string;
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
      kind: 'system.probe',
      result: status === 'succeeded' && isRecord(job.returnvalue) ? job.returnvalue : null,
      status,
    };
  }

  async submit(input: SubmitJobInput): Promise<SubmittedJob> {
    const job = await this.#queue.add(input.kind, input.payload, {
      attempts: 3,
      backoff: { delay: 250, type: 'exponential' },
      removeOnComplete: false,
      removeOnFail: false,
    });

    if (!job.id) {
      throw new Error('BullMQ did not assign a job id');
    }

    return { id: job.id, status: 'queued' };
  }
}

export function createProbeWorker(options: BullMqOptions): Worker {
  return new Worker(
    options.queueName,
    async (job) => {
      if (job.name !== 'system.probe' || job.data.outcome === 'failure') {
        throw new Error('JOB_HANDLER_FAILED');
      }

      return { message: 'processed' };
    },
    {
      connection: connectionFromUrl(options.redisUrl),
    },
  );
}
