import type {
  ObjectStorePort,
  RawAssetDeletionReceipt,
  SaveJobResult,
  SubmissionStore,
} from './ports.js';
import type { ProcessingJob, UploadSession } from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemorySubmissionStore implements SubmissionStore {
  readonly #jobs = new Map<string, ProcessingJob>();
  readonly #uploads = new Map<string, UploadSession>();

  async createJob(job: ProcessingJob): Promise<ProcessingJob> {
    const upload = this.#uploads.get(job.uploadSessionId);
    if (upload?.jobId) {
      const existing = this.#jobs.get(upload.jobId);
      if (existing) {
        return clone(existing);
      }
    }
    this.#jobs.set(job.id, clone(job));
    if (upload) {
      upload.jobId = job.id;
      upload.status = 'submitted';
    }
    return clone(job);
  }

  async createUploadSession(session: UploadSession): Promise<void> {
    this.#uploads.set(session.id, clone(session));
  }

  async findJob(id: string, learningProfileId: string): Promise<ProcessingJob | null> {
    const job = this.#jobs.get(id);
    return job?.learningProfileId === learningProfileId ? clone(job) : null;
  }

  async findUploadSession(id: string, learningProfileId?: string): Promise<UploadSession | null> {
    const upload = this.#uploads.get(id);
    return upload && (!learningProfileId || upload.learningProfileId === learningProfileId)
      ? clone(upload)
      : null;
  }

  async saveJobIfRevision(job: ProcessingJob, expectedRevision: number): Promise<SaveJobResult> {
    const current = this.#jobs.get(job.id);
    if (!current || current.revision !== expectedRevision) {
      return 'revision_conflict';
    }
    this.#jobs.set(job.id, clone(job));
    return 'saved';
  }

  async saveUploadSession(session: UploadSession): Promise<void> {
    this.#uploads.set(session.id, clone(session));
  }
}

export class MemoryObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, Uint8Array>();

  async delete(key: string): Promise<{ proof: string }> {
    this.objects.delete(key);
    const proof = `memory-delete:${key}`;
    return { proof };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.slice() ?? null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
  }
}

export class MemoryRawAssetDeletionLog {
  readonly receipts: RawAssetDeletionReceipt[] = [];

  async record(receipt: RawAssetDeletionReceipt): Promise<void> {
    this.receipts.push({ ...receipt });
  }
}
