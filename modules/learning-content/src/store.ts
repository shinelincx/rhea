import type {
  BasisSelectionVersion,
  ClassificationVersion,
  LearningSourceVersion,
  StoredLearningMaterial,
} from './types.js';

export interface LearningContentStore {
  appendBasisSelection(input: {
    expectedSelectionRevision: number;
    learningProfileId: string;
    materialId: string;
    selection: BasisSelectionVersion;
  }): Promise<boolean>;
  appendClassification(input: {
    classification: ClassificationVersion;
    expectedRevision: number;
    learningProfileId: string;
    materialId: string;
  }): Promise<boolean>;
  appendSourceVersion(input: {
    expectedSourceCount: number;
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
}
