import type {
  AcceptedObjectiveAssessmentSnapshot,
  AssessmentActorReference,
} from '@rhea/assessment';
import type { CurrentLearningBasisReference, Subject } from '@rhea/learning-content';
import type { WrongItemThemeMasteryStatus } from './theme-mastery.js';

export type WrongItemStatus = 'pending_correction' | 'pending_consolidation';
export type WrongItemClassificationStatus = 'classified' | 'pending';
export type MistakeReasonCategory =
  'knowledge' | 'step' | 'comprehension' | 'reading' | 'expression' | 'other';
export type MistakeReasonStatus = 'suggested' | 'confirmed' | 'uncertain' | 'skipped' | 'corrected';

export interface WrongItemClassification {
  knowledgePointNames: string[];
  primaryKnowledgePointName: string | null;
  revision: number;
  status: WrongItemClassificationStatus;
  subject: Subject;
  unitName: string | null;
}

export interface MistakeReasonCandidate {
  category: MistakeReasonCategory;
  evidence: {
    expectedExcerpt: string;
    questionExcerpt: string;
    responseExcerpt: string;
  };
  explanation: string;
  hypothesisDisclosure: '这是根据当前题目、作答和正确依据提出的可能错因，不是对学习者的事实判断。';
  provider: {
    kind: 'deterministic_seed' | 'ai';
    version: string;
  };
}

export interface MistakeReasonRevision {
  action: 'confirm' | 'mark_uncertain' | 'skip' | 'correct';
  actor: AssessmentActorReference;
  category: MistakeReasonCategory | null;
  changedAt: string;
  explanation: string | null;
  id: string;
  reason: string | null;
  revision: number;
}

export interface ImmediateCorrectionAttempt {
  assessmentVersionId: string;
  basis: CurrentLearningBasisReference;
  createdAt: string;
  id: string;
  idempotencyKey: string;
  normalizedResponse: string | null;
  outcome: 'correct' | 'incorrect';
  responseText: string;
}

export interface StoredWrongItem {
  assessment: AcceptedObjectiveAssessmentSnapshot;
  classification: WrongItemClassification;
  correctionAttempts: ImmediateCorrectionAttempt[];
  createdAt: string;
  deduplicationKey: string;
  familySpaceId: string;
  firstIncorrectAt: string;
  id: string;
  learningProfileId: string;
  reasonCandidate: MistakeReasonCandidate;
  reasonHistory: MistakeReasonRevision[];
  stateRevision: number;
  status: WrongItemStatus;
  themeId: string;
  updatedAt: string;
}

export interface WrongItemView extends StoredWrongItem {
  currentReason: {
    category: MistakeReasonCategory | null;
    explanation: string | null;
    status: MistakeReasonStatus;
  };
}

export interface WrongItemThemeView {
  firstIncorrectAt: string;
  id: string;
  itemCount: number;
  knowledgePointName: string | null;
  masteredAt: string | null;
  masteryCycle: number;
  masteryStatus: WrongItemThemeMasteryStatus;
  status: WrongItemClassificationStatus;
  subject: Subject;
  unitName: string | null;
}

export interface WrongItemLibraryView {
  items: WrongItemView[];
  themes: WrongItemThemeView[];
}

export interface WrongItemFilter {
  classificationStatus?: WrongItemClassificationStatus;
  knowledgePointName?: string;
  masteryStatus?: WrongItemThemeMasteryStatus | 'all';
  subject?: Subject;
  unitName?: string;
}
