import { randomUUID } from 'node:crypto';

const PRODUCTION_DATABASE_URL_KEYS = [
  'DATABASE_URL',
  'GOVERNANCE_DATABASE_URL',
  'OPERATIONS_DATABASE_URL',
  'PROVIDER_RUNTIME_DATABASE_URL',
  'SUPPORT_DATABASE_URL',
] as const;

export function validateProductionTransportSecurity(
  environment: Record<string, string | undefined>,
): void {
  if (environment.NODE_ENV !== 'production') return;
  for (const key of PRODUCTION_DATABASE_URL_KEYS) {
    const value = environment[key];
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${key} must be a valid PostgreSQL URL`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.searchParams.get('sslmode') !== 'verify-full'
    ) {
      throw new Error(`${key} must use PostgreSQL sslmode=verify-full in production`);
    }
  }
  const redisUrl = environment.REDIS_URL;
  if (redisUrl) {
    let url: URL;
    try {
      url = new URL(redisUrl);
    } catch {
      throw new Error('REDIS_URL must be a valid Redis URL');
    }
    if (url.protocol !== 'rediss:') {
      throw new Error('REDIS_URL must use rediss:// in production');
    }
  }
}

export const JOB_KINDS = [
  'system.probe',
  'submission.recognize',
  'generated-learning.generate',
  'open-assessment.generate',
  'privacy.process',
  'review-card.generate',
] as const;

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
  'submission.recognize': {
    attempts: 4,
    backoff: { delayMs: 65_000, strategy: 'fixed' },
  },
  'generated-learning.generate': {
    attempts: 4,
    backoff: { delayMs: 65_000, strategy: 'fixed' },
  },
  'open-assessment.generate': {
    attempts: 4,
    backoff: { delayMs: 65_000, strategy: 'fixed' },
  },
  'privacy.process': {
    attempts: 120,
    backoff: { delayMs: 6 * 60 * 60 * 1000, strategy: 'fixed' },
  },
  'review-card.generate': {
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
      kind: 'submission.recognize';
      payload: { learningProfileId: string; processingJobId: string };
    }
  | {
      deduplicationKey?: string;
      kind: 'privacy.process';
      payload: { taskId: string };
    }
  | {
      deduplicationKey?: string;
      kind: 'review-card.generate';
      payload: { learningProfileId: string; requestId: string };
    }
  | {
      deduplicationKey?: string;
      kind: 'generated-learning.generate';
      payload: { learningProfileId: string; requestId: string };
    }
  | {
      deduplicationKey?: string;
      kind: 'open-assessment.generate';
      payload: { learningProfileId: string; suggestionId: string };
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
      kind: 'submission.recognize';
      payload: { learningProfileId: string; processingJobId: string };
    })
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'privacy.process';
      payload: { taskId: string };
    })
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'review-card.generate';
      payload: { learningProfileId: string; requestId: string };
    })
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'generated-learning.generate';
      payload: { learningProfileId: string; requestId: string };
    })
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'open-assessment.generate';
      payload: { learningProfileId: string; suggestionId: string };
    })
  | (Omit<ObservableJob, 'kind'> & {
      kind: 'system.probe';
      payload: { outcome?: unknown };
    });

function storedJob(input: SubmitJobInput, id: string): StoredJob {
  const common = {
    attempts: 0,
    errorCode: null,
    id,
    result: null,
    status: 'queued',
  } as const;
  switch (input.kind) {
    case 'submission.recognize':
      return { ...common, kind: input.kind, payload: { ...input.payload } };
    case 'generated-learning.generate':
      return { ...common, kind: input.kind, payload: { ...input.payload } };
    case 'review-card.generate':
      return { ...common, kind: input.kind, payload: { ...input.payload } };
    case 'open-assessment.generate':
      return { ...common, kind: input.kind, payload: { ...input.payload } };
    case 'privacy.process':
      return { ...common, kind: input.kind, payload: { ...input.payload } };
    case 'system.probe':
      return { ...common, kind: input.kind, payload: { ...input.payload } };
  }
}

function submitInput(job: StoredJob): SubmitJobInput {
  switch (job.kind) {
    case 'submission.recognize':
      return { kind: job.kind, payload: { ...job.payload } };
    case 'generated-learning.generate':
      return { kind: job.kind, payload: { ...job.payload } };
    case 'review-card.generate':
      return { kind: job.kind, payload: { ...job.payload } };
    case 'open-assessment.generate':
      return { kind: job.kind, payload: { ...job.payload } };
    case 'privacy.process':
      return { kind: job.kind, payload: { ...job.payload } };
    case 'system.probe':
      return { kind: job.kind, payload: { ...job.payload } };
  }
}

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
    this.#jobs.set(id, storedJob(input, id));
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
      job.result = await handler(submitInput(job));
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
