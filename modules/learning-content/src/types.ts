export type Subject = 'chinese' | 'mathematics' | 'english' | 'science';

export type LearningSourceKind = 'learning_material' | 'question' | 'answer' | 'grading_basis';

export interface LearningActorReference {
  id: string;
  type: 'guardian' | 'learner';
}

export interface ProfessionalLearningReviewerReference {
  id: string;
  type: 'professional';
}

export interface ClassificationDraft {
  coursePathName: string | null;
  knowledgePointNames: string[];
  primaryKnowledgePointName: string | null;
  primarySubject: Subject | null;
  relatedSubjects: Subject[];
  unitName: string | null;
}

export interface CoursePathReference {
  id: string;
  name: string;
  subject: Subject;
}

export interface LearningUnitReference {
  coursePathId: string | null;
  id: string;
  name: string;
  subject: Subject;
}

export interface KnowledgePointReference {
  id: string;
  name: string;
  primary: boolean;
  subject: Subject;
}

export interface ClassificationVersion {
  changedAt: string;
  changedBy: LearningActorReference;
  coursePath: CoursePathReference | null;
  id: string;
  knowledgePoints: KnowledgePointReference[];
  predecessorId: string | null;
  primarySubject: Subject | null;
  reason: string | null;
  relatedSubjects: Subject[];
  revision: number;
  source: 'correction' | 'initial';
  status: 'classified' | 'pending';
  unit: LearningUnitReference | null;
}

export interface LearningSourceVersion {
  conflictsWithSourceVersionIds: string[];
  contentHash: string;
  createdAt: string;
  createdBy: LearningActorReference;
  id: string;
  kind: LearningSourceKind;
  label: string;
  sourceKey: string;
  sourceConfirmedContentVersionId: string | null;
  versionLabel: string;
  versionNumber: number;
}

export interface BasisSelectionVersion {
  id: string;
  reason: string;
  selectedAt: string;
  selectedBy: LearningActorReference;
  sourceVersionId: string;
  version: number;
}

export interface LearningBasisView {
  conflictingSourceVersionIds: string[];
  currentSourceVersionId: string;
  hasConflict: boolean;
  selectionRevision: number;
}

export interface CurrentLearningBasisReference {
  contentHash: string;
  kind: LearningSourceKind;
  materialId: string;
  selectionVersion: number;
  sourceVersionId: string;
  validityEpoch: number;
  versionLabel: string;
}

export interface CurrentLearningContextReference {
  basis: CurrentLearningBasisReference;
  classificationRevision: number;
  confirmedContentVersionId: string;
  coursePathName: string | null;
  knowledgePointNames: string[];
  primaryKnowledgePointName: string | null;
  subject: Subject | null;
  unitName: string | null;
}

export interface LearningMaterial {
  basis: LearningBasisView;
  basisSelectionHistory: BasisSelectionVersion[];
  classificationHistory: ClassificationVersion[];
  confirmedContentVersionId: string;
  createdAt: string;
  currentClassification: ClassificationVersion;
  familySpaceId: string;
  id: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  learningProfileId: string;
  sourceHash: string;
  sourceVersions: LearningSourceVersion[];
  validityEpoch: number;
}

export interface StoredLearningMaterial extends Omit<
  LearningMaterial,
  'basis' | 'currentClassification'
> {}
