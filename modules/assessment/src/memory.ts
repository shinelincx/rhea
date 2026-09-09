import type { AssessmentStore } from './store.js';
import type { StoredObjectiveAssessment } from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryAssessmentStore implements AssessmentStore {
  readonly #assessments = new Map<string, StoredObjectiveAssessment>();

  async appendDispute(input: Parameters<AssessmentStore['appendDispute']>[0]): Promise<boolean> {
    const assessment = this.#matching(input.assessmentId, input.learningProfileId);
    if (
      !assessment ||
      assessment.openDisputeId ||
      assessment.versions.at(-1)?.id !== input.expectedCurrentVersionId
    ) {
      return false;
    }
    assessment.disputes.push(clone(input.dispute));
    assessment.openDisputeId = input.dispute.id;
    return true;
  }

  async createAssessment(assessment: StoredObjectiveAssessment): Promise<boolean> {
    if (this.#assessments.has(assessment.id)) return false;
    this.#assessments.set(assessment.id, clone(assessment));
    return true;
  }

  async findAssessment(
    id: string,
    learningProfileId: string,
  ): Promise<StoredObjectiveAssessment | null> {
    const assessment = this.#matching(id, learningProfileId);
    return assessment ? clone(assessment) : null;
  }

  async findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredObjectiveAssessment | null> {
    const assessment = [...this.#assessments.values()].find(
      (candidate) =>
        candidate.learningProfileId === learningProfileId &&
        candidate.deduplicationKey === deduplicationKey,
    );
    return assessment ? clone(assessment) : null;
  }

  async recordAccess(_input: Parameters<AssessmentStore['recordAccess']>[0]): Promise<void> {}

  async resolveDispute(input: Parameters<AssessmentStore['resolveDispute']>[0]): Promise<boolean> {
    const assessment = this.#matching(input.assessmentId, input.learningProfileId);
    if (
      !assessment ||
      assessment.openDisputeId !== input.expectedOpenDisputeId ||
      assessment.versions.at(-1)?.id !== input.expectedCurrentVersionId
    ) {
      return false;
    }
    assessment.versions.push(clone(input.version));
    assessment.resolutions.push(clone(input.resolution));
    assessment.openDisputeId = null;
    return true;
  }

  #matching(id: string, learningProfileId: string): StoredObjectiveAssessment | null {
    const assessment = this.#assessments.get(id);
    return assessment?.learningProfileId === learningProfileId ? assessment : null;
  }
}
