import type { LearningProgressStore } from './store.js';
import { MemoryThemeMasteryRepository } from './theme-mastery-memory.js';
import { qualifyLearningEvidence } from './theme-mastery.js';
import type { StoredWrongItem } from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryLearningProgressStore implements LearningProgressStore {
  readonly #items = new Map<string, StoredWrongItem>();
  readonly mastery: MemoryThemeMasteryRepository;

  constructor(mastery = new MemoryThemeMasteryRepository()) {
    this.mastery = mastery;
  }

  async createWrongItem(
    item: StoredWrongItem,
    evidence: Parameters<LearningProgressStore['createWrongItem']>[1],
  ): Promise<boolean> {
    const existingTheme = this.mastery.find(item.themeId, item.learningProfileId);
    if (
      evidence.familySpaceId !== item.familySpaceId ||
      evidence.learningProfileId !== item.learningProfileId ||
      evidence.themeId !== item.themeId ||
      evidence.wrongItemId !== item.id ||
      evidence.sourceKind !== 'wrong_item_capture' ||
      evidence.sourceReferenceId !== item.id ||
      evidence.outcome !== 'incorrect' ||
      evidence.qualification !== qualifyLearningEvidence(evidence) ||
      (existingTheme && existingTheme.familySpaceId !== item.familySpaceId) ||
      [...this.#items.values()].some(
        (candidate) =>
          candidate.learningProfileId === item.learningProfileId &&
          candidate.deduplicationKey === item.deduplicationKey,
      )
    ) {
      return false;
    }
    this.#items.set(item.id, clone(item));
    this.mastery.registerTheme({
      familySpaceId: item.familySpaceId,
      learningProfileId: item.learningProfileId,
      occurredAt: item.firstIncorrectAt,
      reason: 'new_error',
      themeId: item.themeId,
      triggerKey: `wrong-item:${item.id}`,
    });
    if (!this.mastery.recordEvidence(evidence)) {
      this.#items.delete(item.id);
      return false;
    }
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

  async findWrongItemThemeMastery(themeId: string, learningProfileId: string) {
    return this.mastery.find(themeId, learningProfileId);
  }

  async reopenWrongItemThemeForInvalidSource(
    input: Parameters<LearningProgressStore['reopenWrongItemThemeForInvalidSource']>[0],
  ): Promise<boolean> {
    return this.mastery.reopenForInvalidSource(input) !== null;
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
    if (!this.mastery.recordEvidence(input.evidence)) return false;
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
    this.mastery.registerTheme({
      familySpaceId: item.familySpaceId,
      learningProfileId: item.learningProfileId,
      occurredAt: input.updatedAt,
      reason: 'classification_changed',
      themeId: input.themeId,
      triggerKey: `classification:${item.id}:${input.classification.revision}`,
    });
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
