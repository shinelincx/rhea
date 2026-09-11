import type {
  AcceptedObjectiveAssessmentSnapshot,
  AssessmentActorReference,
  ImmediateCorrectionEvaluation,
} from '@rhea/assessment';
import type { CurrentLearningContextReference } from '@rhea/learning-content';

import type { MistakeReasonCandidate } from './types.js';

export interface AcceptedObjectiveAssessmentReader {
  evaluateImmediateCorrection(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    learningProfileId: string;
    responseText: string;
  }): Promise<ImmediateCorrectionEvaluation>;
  getAcceptedObjectiveAssessmentSnapshot(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    learningProfileId: string;
  }): Promise<AcceptedObjectiveAssessmentSnapshot>;
}

export interface LearningContextReader {
  getCurrentLearningContextReference(input: {
    actor: AssessmentActorReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<CurrentLearningContextReference>;
}

export interface MistakeReasonSuggestionProvider {
  suggest(input: AcceptedObjectiveAssessmentSnapshot): Promise<MistakeReasonCandidate>;
}
