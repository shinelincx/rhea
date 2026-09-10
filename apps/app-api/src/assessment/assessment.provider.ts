import type { AssessmentService, SuggestedAssessmentService } from '@rhea/assessment';

export const ASSESSMENT_SERVICE = Symbol('ASSESSMENT_SERVICE');
export const SUGGESTED_ASSESSMENT_SERVICE = Symbol('SUGGESTED_ASSESSMENT_SERVICE');
export type { AssessmentService };
export type { SuggestedAssessmentService };
