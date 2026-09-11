import type { AssessmentActorReference } from '@rhea/assessment';

import type {
  ImmediateCorrectionAttempt,
  MistakeReasonRevision,
  StoredWrongItem,
  WrongItemClassification,
} from './types.js';

export interface LearningProgressStore {
  createWrongItem(item: StoredWrongItem): Promise<boolean>;
  findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredWrongItem | null>;
  findById(id: string, learningProfileId: string): Promise<StoredWrongItem | null>;
  listWrongItems(learningProfileId: string): Promise<StoredWrongItem[]>;
  recordAccess(input: {
    action: string;
    actor: AssessmentActorReference;
    familySpaceId: string;
    learningProfileId: string;
    wrongItemId: string;
  }): Promise<void>;
  recordCorrection(input: {
    attempt: ImmediateCorrectionAttempt;
    expectedStateRevision: number;
    learningProfileId: string;
    status: StoredWrongItem['status'];
    updatedAt: string;
    wrongItemId: string;
  }): Promise<boolean>;
  reviseClassification(input: {
    actor: AssessmentActorReference;
    classification: WrongItemClassification;
    expectedStateRevision: number;
    learningProfileId: string;
    themeId: string;
    updatedAt: string;
    wrongItemId: string;
  }): Promise<boolean>;
  reviseReason(input: {
    expectedStateRevision: number;
    learningProfileId: string;
    revision: MistakeReasonRevision;
    updatedAt: string;
    wrongItemId: string;
  }): Promise<boolean>;
}
