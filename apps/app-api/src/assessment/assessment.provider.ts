import type {
  AssessmentService,
  SuggestedAssessmentService,
  SuggestedAssessmentView,
} from '@rhea/assessment';

export const ASSESSMENT_SERVICE = Symbol('ASSESSMENT_SERVICE');
export const SUGGESTED_ASSESSMENT_SERVICE = Symbol('SUGGESTED_ASSESSMENT_SERVICE');
export const SUGGESTED_ASSESSMENT_SCHEDULER = Symbol('SUGGESTED_ASSESSMENT_SCHEDULER');
export interface SuggestedAssessmentScheduler {
  schedule(request: Pick<SuggestedAssessmentView, 'id' | 'learningProfileId'>): Promise<void>;
}
export type { AssessmentService };
export type { SuggestedAssessmentService };
