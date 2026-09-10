import type { SuggestedAssessmentStore } from './suggested-assessment.store.js';
import type { StoredSuggestedAssessment } from './suggested-assessment.types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemorySuggestedAssessmentStore implements SuggestedAssessmentStore {
  readonly #items = new Map<string, StoredSuggestedAssessment>();

  async create(assessment: StoredSuggestedAssessment): Promise<boolean> {
    if (this.#items.has(assessment.id)) return false;
    if (
      [...this.#items.values()].some(
        (item) =>
          item.learningProfileId === assessment.learningProfileId &&
          item.deduplicationKey === assessment.deduplicationKey,
      )
    ) {
      return false;
    }
    this.#items.set(assessment.id, clone(assessment));
    return true;
  }

  async findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredSuggestedAssessment | null> {
    const item = [...this.#items.values()].find(
      (candidate) =>
        candidate.learningProfileId === learningProfileId &&
        candidate.deduplicationKey === deduplicationKey,
    );
    return item ? clone(item) : null;
  }

  async findById(id: string, learningProfileId: string): Promise<StoredSuggestedAssessment | null> {
    const item = this.#items.get(id);
    return item?.learningProfileId === learningProfileId ? clone(item) : null;
  }

  async readAcceptedResultReference(
    input: Parameters<SuggestedAssessmentStore['readAcceptedResultReference']>[0],
  ) {
    const item = this.#items.get(input.suggestionId);
    return item?.learningProfileId === input.learningProfileId && item.acceptedResult
      ? {
          assessmentId: item.id,
          assessmentVersionId: item.acceptedResult.id,
          basisSelectionVersion: item.basis.selectionVersion,
          basisSourceVersionId: item.basis.sourceVersionId,
          basisValidityEpoch: item.basis.validityEpoch,
          questionVersionId: item.question.versionId,
          responseVersionId: item.response.versionId,
          rubricId: item.acceptedResult.rubricId,
          rubricVersion: item.acceptedResult.rubricVersion,
          subject: item.question.subject,
        }
      : null;
  }

  async review(input: Parameters<SuggestedAssessmentStore['review']>[0]): Promise<boolean> {
    const item = this.#items.get(input.suggestionId);
    if (
      !item ||
      item.learningProfileId !== input.learningProfileId ||
      item.status !== 'pending_review' ||
      item.stateRevision !== input.expectedStateRevision
    ) {
      return false;
    }
    item.acceptedResult = clone(input.acceptedResult);
    item.review = clone(input.review);
    item.stateRevision += 1;
    item.status = input.status;
    item.updatedAt = input.updatedAt;
    return true;
  }
}
