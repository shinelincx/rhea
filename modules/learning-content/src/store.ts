import type {
  BasisSelectionVersion,
  ClassificationVersion,
  LearningSourceVersion,
  StoredLearningMaterial,
  ProfessionalLearningReviewerReference,
  LearningActorReference,
} from './types.js';

export interface LearningContentStore {
  appendBasisSelection(input: {
    expectedSelectionRevision: number;
    expectedValidityEpoch: number;
    learningProfileId: string;
    materialId: string;
    selection: BasisSelectionVersion;
  }): Promise<boolean>;
  appendClassification(input: {
    classification: ClassificationVersion;
    expectedRevision: number;
    expectedValidityEpoch: number;
    learningProfileId: string;
    materialId: string;
  }): Promise<boolean>;
  appendSourceVersion(input: {
    expectedSourceCount: number;
    expectedValidityEpoch: number;
    learningProfileId: string;
    materialId: string;
    sourceVersion: LearningSourceVersion;
  }): Promise<boolean>;
  createMaterial(material: StoredLearningMaterial): Promise<boolean>;
  findByConfirmedContent(
    confirmedContentVersionId: string,
    learningProfileId: string,
  ): Promise<StoredLearningMaterial | null>;
  findMaterial(id: string, learningProfileId: string): Promise<StoredLearningMaterial | null>;
  invalidateMaterial(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    eventId: string;
    expectedValidityEpoch: number;
    invalidatedAt: string;
    learningProfileId: string;
    materialId: string;
    reason: string;
  }): Promise<boolean>;
  recordAccess(input: {
    action: string;
    actor: LearningActorReference | ProfessionalLearningReviewerReference;
    familySpaceId: string;
    learningProfileId: string;
    materialId: string;
  }): Promise<void>;
}
