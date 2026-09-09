import type { LearningContentStore } from './store.js';
import type { StoredLearningMaterial } from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryLearningContentStore implements LearningContentStore {
  readonly #materials = new Map<string, StoredLearningMaterial>();

  async appendBasisSelection(
    input: Parameters<LearningContentStore['appendBasisSelection']>[0],
  ): Promise<boolean> {
    const material = this.#matching(input.materialId, input.learningProfileId);
    if (!material || material.basisSelectionHistory.length !== input.expectedSelectionRevision) {
      return false;
    }
    material.basisSelectionHistory.push(clone(input.selection));
    return true;
  }

  async appendClassification(
    input: Parameters<LearningContentStore['appendClassification']>[0],
  ): Promise<boolean> {
    const material = this.#matching(input.materialId, input.learningProfileId);
    if (!material || material.classificationHistory.length !== input.expectedRevision) {
      return false;
    }
    material.classificationHistory.push(clone(input.classification));
    return true;
  }

  async appendSourceVersion(
    input: Parameters<LearningContentStore['appendSourceVersion']>[0],
  ): Promise<boolean> {
    const material = this.#matching(input.materialId, input.learningProfileId);
    if (!material || material.sourceVersions.length !== input.expectedSourceCount) {
      return false;
    }
    material.sourceVersions.push(clone(input.sourceVersion));
    return true;
  }

  async createMaterial(material: StoredLearningMaterial): Promise<boolean> {
    if (
      [...this.#materials.values()].some(
        (existing) =>
          existing.learningProfileId === material.learningProfileId &&
          existing.confirmedContentVersionId === material.confirmedContentVersionId,
      )
    ) {
      return false;
    }
    this.#materials.set(material.id, clone(material));
    return true;
  }

  async findByConfirmedContent(
    confirmedContentVersionId: string,
    learningProfileId: string,
  ): Promise<StoredLearningMaterial | null> {
    const material = [...this.#materials.values()].find(
      (candidate) =>
        candidate.confirmedContentVersionId === confirmedContentVersionId &&
        candidate.learningProfileId === learningProfileId,
    );
    return material ? clone(material) : null;
  }

  async findMaterial(
    id: string,
    learningProfileId: string,
  ): Promise<StoredLearningMaterial | null> {
    const material = this.#matching(id, learningProfileId);
    return material ? clone(material) : null;
  }

  async invalidateMaterial(
    input: Parameters<LearningContentStore['invalidateMaterial']>[0],
  ): Promise<boolean> {
    const material = this.#matching(input.materialId, input.learningProfileId);
    if (!material || material.validityEpoch !== input.expectedValidityEpoch) return false;
    material.validityEpoch += 1;
    material.invalidatedAt = input.invalidatedAt;
    material.invalidationReason = input.reason;
    return true;
  }

  async recordAccess(_input: Parameters<LearningContentStore['recordAccess']>[0]): Promise<void> {}

  #matching(id: string, learningProfileId: string): StoredLearningMaterial | null {
    const material = this.#materials.get(id);
    return material?.learningProfileId === learningProfileId ? material : null;
  }
}
