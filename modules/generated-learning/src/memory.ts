import type { GeneratedLearningStore } from './store.js';
import { generatedLearningSourceKey } from './source-key.js';
import type { StoredGenerationRequest } from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryGeneratedLearningStore implements GeneratedLearningStore {
  readonly #idempotency = new Map<string, string>();
  readonly #requests = new Map<string, StoredGenerationRequest>();
  readonly hintUsages: Array<{
    level: 1 | 2 | 3;
    requestId: string;
    versionId: string;
  }> = [];

  async cancel(input: Parameters<GeneratedLearningStore['cancel']>[0]): Promise<boolean> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.stateRevision !== input.expectedStateRevision ||
      !['queued', 'generating'].includes(request.status)
    ) {
      return false;
    }
    request.processingLeaseExpiresAt = null;
    request.stateRevision += 1;
    request.status = 'canceled';
    request.unavailableReason = input.reason;
    request.updatedAt = input.updatedAt;
    return true;
  }

  async complete(
    input: Parameters<GeneratedLearningStore['complete']>[0],
  ): ReturnType<GeneratedLearningStore['complete']> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.status !== 'generating' ||
      request.stateRevision !== input.expectedStateRevision
    ) {
      return 'conflict';
    }
    request.currentVersionId = input.version.id;
    request.latestChecks = clone(input.latestChecks);
    request.modelRuns.push(...clone(input.modelRuns));
    request.processingLeaseExpiresAt = null;
    request.stateRevision += 1;
    request.status = 'ready';
    request.unavailableReason = null;
    request.updatedAt = input.version.createdAt;
    request.versions.push(clone(input.version));
    return 'completed';
  }

  async create(request: StoredGenerationRequest): Promise<boolean> {
    const key = `${request.learningProfileId}:${request.idempotencyKey}`;
    if (this.#idempotency.has(key) || this.#requests.has(request.id)) return false;
    this.#requests.set(request.id, clone(request));
    this.#idempotency.set(key, request.id);
    return true;
  }

  async fail(input: Parameters<GeneratedLearningStore['fail']>[0]): Promise<boolean> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.status !== 'generating' ||
      request.stateRevision !== input.expectedStateRevision ||
      !input.reason
    ) {
      return false;
    }
    request.latestChecks = clone(input.latestChecks);
    request.modelRuns.push(...clone(input.modelRuns));
    request.processingLeaseExpiresAt = null;
    request.stateRevision += 1;
    request.status = 'unavailable';
    request.unavailableReason = input.reason;
    request.updatedAt = input.updatedAt;
    return true;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<StoredGenerationRequest | null> {
    const id = this.#idempotency.get(`${learningProfileId}:${idempotencyKey}`);
    const request = id ? this.#requests.get(id) : null;
    return request ? clone(request) : null;
  }

  async findLatestReadyForSource(
    sourceKey: string,
    learningProfileId: string,
  ): Promise<StoredGenerationRequest | null> {
    const request = [...this.#requests.values()]
      .filter(
        (candidate) =>
          candidate.learningProfileId === learningProfileId &&
          candidate.status === 'ready' &&
          this.#sourceKey(candidate) === sourceKey,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return request ? clone(request) : null;
  }

  async findById(id: string, learningProfileId: string): Promise<StoredGenerationRequest | null> {
    const request = this.#requests.get(id);
    return request?.learningProfileId === learningProfileId ? clone(request) : null;
  }

  async markGenerating(
    input: Parameters<GeneratedLearningStore['markGenerating']>[0],
  ): Promise<boolean> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.stateRevision !== input.expectedStateRevision ||
      (request.status !== 'queued' &&
        !(
          request.status === 'generating' &&
          request.processingLeaseExpiresAt !== null &&
          request.processingLeaseExpiresAt <= input.now
        ))
    ) {
      return false;
    }
    request.stateRevision += 1;
    request.status = 'generating';
    request.processingLeaseExpiresAt = input.leaseExpiresAt;
    request.updatedAt = input.updatedAt;
    return true;
  }

  async recordHintUsage(
    input: Parameters<GeneratedLearningStore['recordHintUsage']>[0],
  ): ReturnType<GeneratedLearningStore['recordHintUsage']> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.status !== 'ready' ||
      request.currentVersionId !== input.versionId ||
      request.revealedHintLevel !== input.expectedLevel
    ) {
      return 'conflict';
    }
    request.revealedHintLevel = input.nextLevel;
    request.stateRevision += 1;
    request.updatedAt = input.occurredAt;
    this.hintUsages.push({
      level: input.nextLevel,
      requestId: input.requestId,
      versionId: input.versionId,
    });
    return 'completed';
  }

  #sourceKey(request: StoredGenerationRequest): string {
    return generatedLearningSourceKey(request.source);
  }
}
