import { randomUUID } from 'node:crypto';

export type JobKind = 'system.probe';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface SubmitJobInput {
  kind: JobKind;
  payload: Record<string, unknown>;
}

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

interface StoredJob extends ObservableJob {
  payload: Record<string, unknown>;
}

class MemoryJobRuntime implements JobRuntime {
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
    const id = randomUUID();
    this.#jobs.set(id, {
      attempts: 0,
      errorCode: null,
      id,
      kind: input.kind,
      payload: { ...input.payload },
      result: null,
      status: 'queued',
    });
    this.#queue.push(id);
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
      job.result = await handler({ kind: job.kind, payload: { ...job.payload } });
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
