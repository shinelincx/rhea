import { randomUUID } from 'node:crypto';

export const JOB_KINDS = ['system.probe', 'generated-learning.generate'] as const;

export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobRetryPolicy {
  attempts: number;
  backoff: {
    delayMs: number;
    strategy: 'exponential' | 'fixed';
  };
}

const JOB_RETRY_POLICIES: Record<JobKind, JobRetryPolicy> = {
  'generated-learning.generate': {
    attempts: 4,
    backoff: { delayMs: 65_000, strategy: 'fixed' },
  },
  'system.probe': {
    attempts: 3,
    backoff: { delayMs: 250, strategy: 'exponential' },
  },
};

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && JOB_KINDS.some((kind) => kind === value);
}

export function getJobRetryPolicy(kind: JobKind): JobRetryPolicy {
  const policy = JOB_RETRY_POLICIES[kind];
  return { attempts: policy.attempts, backoff: { ...policy.backoff } };
}

export type SubmitJobInput =
  | {
      deduplicationKey?: string;
      kind: 'generated-learning.generate';
      payload: { learningProfileId: string; requestId: string };
    }
  | {
      deduplicationKey?: string;
      kind: 'system.probe';
      payload: { outcome?: unknown };
    };

export interface SubmittedJob {
  id: string;
  status: 'queued';
}

export interface ObservableJob {
  attempts: number;
  errorCode: 'JOB_HANDLER_FAILED' | null;
  id: string;
  kind: JobKind;
  result: Record<string, unknown> | null;
  status: JobStatus;
}

export type JobHandler = (input: SubmitJobInput) => Promise<Record<string, unknown>>;

export interface JobClient {
  get(id: string): Promise<ObservableJob | null>;
  submit(input: SubmitJobInput): Promise<SubmittedJob>;
}

export interface JobRuntime extends JobClient {
  workNext(handler: JobHandler): Promise<boolean>;
}

type StoredJob =
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'generated-learning.generate';
      payload: { learningProfileId: string; requestId: string };
    })
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'system.probe';
      payload: { outcome?: unknown };
    });

class MemoryJobRuntime implements JobRuntime {
  readonly #deduplication = new Map<string, string>();
  readonly #jobs = new Map<string, StoredJob>();
  readonly #queue: string[] = [];

  async get(id: string): Promise<ObservableJob | null> {
    const job = this.#jobs.get(id);
    if (!job) {
      return null;
    }

    return {
      attempts: job.attempts,
      errorCode: job.errorCode,
      id: job.id,
      kind: job.kind,
      result: job.result ? { ...job.result } : null,
      status: job.status,
    };
  }

  async submit(input: SubmitJobInput): Promise<SubmittedJob> {
    if (input.deduplicationKey) {
      const existingId = this.#deduplication.get(`${input.kind}:${input.deduplicationKey}`);
      const existing = existingId ? this.#jobs.get(existingId) : null;
      if (existing && existing.status !== 'failed') return { id: existing.id, status: 'queued' };
      if (existingId) this.#deduplication.delete(`${input.kind}:${input.deduplicationKey}`);
    }
    const id = randomUUID();
    const job = {
      attempts: 0,
      errorCode: null,
      id,
      payload: { ...input.payload },
      result: null,
      status: 'queued',
    } as const;
    this.#jobs.set(
      id,
      input.kind === 'generated-learning.generate'
        ? { ...job, kind: input.kind, payload: { ...input.payload } }
        : { ...job, kind: input.kind, payload: { ...input.payload } },
    );
    this.#queue.push(id);
    if (input.deduplicationKey) {
      this.#deduplication.set(`${input.kind}:${input.deduplicationKey}`, id);
    }
    return { id, status: 'queued' };
  }

  async workNext(handler: JobHandler): Promise<boolean> {
    const id = this.#queue.shift();
    if (!id) {
      return false;
    }

    const job = this.#jobs.get(id);
    if (!job) {
      return false;
    }

    job.attempts += 1;
    job.status = 'running';
    try {
      job.result = await handler(
        job.kind === 'generated-learning.generate'
          ? { kind: job.kind, payload: { ...job.payload } }
          : { kind: job.kind, payload: { ...job.payload } },
      );
      job.status = 'succeeded';
    } catch {
      job.errorCode = 'JOB_HANDLER_FAILED';
      job.result = null;
      job.status = 'failed';
    }
    return true;
  }
}

export function createMemoryJobRuntime(): JobRuntime {
  return new MemoryJobRuntime();
}
