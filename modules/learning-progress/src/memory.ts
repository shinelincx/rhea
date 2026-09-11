import type { LearningProgressStore } from './store.js';
import type { StoredWrongItem } from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryLearningProgressStore implements LearningProgressStore {
  readonly #items = new Map<string, StoredWrongItem>();

  async createWrongItem(item: StoredWrongItem): Promise<boolean> {
    if (
      [...this.#items.values()].some(
        (candidate) =>
          candidate.learningProfileId === item.learningProfileId &&
          candidate.deduplicationKey === item.deduplicationKey,
      )
    ) {
      return false;
    }
    this.#items.set(item.id, clone(item));
    return true;
  }

  async findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredWrongItem | null> {
    const item = [...this.#items.values()].find(
      (candidate) =>
        candidate.learningProfileId === learningProfileId &&
        candidate.deduplicationKey === deduplicationKey,
    );
    return item ? clone(item) : null;
  }

  async findById(id: string, learningProfileId: string): Promise<StoredWrongItem | null> {
    const item = this.#items.get(id);
    return item?.learningProfileId === learningProfileId ? clone(item) : null;
  }

  async listWrongItems(learningProfileId: string): Promise<StoredWrongItem[]> {
    return [...this.#items.values()]
      .filter((item) => item.learningProfileId === learningProfileId)
      .map(clone);
  }

  async recordAccess(): Promise<void> {}

  async recordCorrection(
    input: Parameters<LearningProgressStore['recordCorrection']>[0],
  ): Promise<boolean> {
    const item = this.#items.get(input.wrongItemId);
    if (
      !item ||
      item.learningProfileId !== input.learningProfileId ||
      item.stateRevision !== input.expectedStateRevision
    ) {
      return false;
    }
    if (
      item.correctionAttempts.some(
        ({ idempotencyKey }) => idempotencyKey === input.attempt.idempotencyKey,
      )
    ) {
      return true;
    }
    item.correctionAttempts.push(clone(input.attempt));
    item.stateRevision += 1;
    item.status = input.status;
    item.updatedAt = input.updatedAt;
    return true;
  }

  async reviseClassification(
    input: Parameters<LearningProgressStore['reviseClassification']>[0],
  ): Promise<boolean> {
    const item = this.#items.get(input.wrongItemId);
    if (
      !item ||
      item.learningProfileId !== input.learningProfileId ||
      item.stateRevision !== input.expectedStateRevision
    ) {
      return false;
    }
    item.classification = clone(input.classification);
    item.stateRevision += 1;
    item.themeId = input.themeId;
    item.updatedAt = input.updatedAt;
    return true;
  }

  async reviseReason(
    input: Parameters<LearningProgressStore['reviseReason']>[0],
  ): Promise<boolean> {
    const item = this.#items.get(input.wrongItemId);
    if (
      !item ||
      item.learningProfileId !== input.learningProfileId ||
      item.stateRevision !== input.expectedStateRevision
    ) {
      return false;
    }
    item.reasonHistory.push(clone(input.revision));
    item.stateRevision += 1;
    item.updatedAt = input.updatedAt;
    return true;
  }
}
