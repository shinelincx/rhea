import type {
  AcceptedOpenAssessmentResultReference,
  AcceptedOpenAssessmentResult,
  OpenAssessmentReviewRecord,
  StoredSuggestedAssessment,
} from './suggested-assessment.types.js';

export interface SuggestedAssessmentStore {
  create(assessment: StoredSuggestedAssessment): Promise<boolean>;
  findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredSuggestedAssessment | null>;
  findById(id: string, learningProfileId: string): Promise<StoredSuggestedAssessment | null>;
  markGenerating(input: {
    expectedStateRevision: number;
    learningProfileId: string;
    processingLeaseExpiresAt: string;
    suggestionId: string;
    updatedAt: string;
  }): Promise<boolean>;
  completeGeneration(input: {
    expectedStateRevision: number;
    learningProfileId: string;
    modelRun: StoredSuggestedAssessment['modelRun'];
    requiresProfessionalReview: boolean;
    status: 'pending_review' | 'unavailable';
    suggestion: StoredSuggestedAssessment['suggestion'];
    suggestionId: string;
    unavailableReason: StoredSuggestedAssessment['unavailableReason'];
    updatedAt: string;
  }): Promise<boolean>;
  readAcceptedResultReference(input: {
    learningProfileId: string;
    suggestionId: string;
  }): Promise<AcceptedOpenAssessmentResultReference | null>;
  review(input: {
    acceptedResult: AcceptedOpenAssessmentResult | null;
    expectedStateRevision: number;
    learningProfileId: string;
    review: OpenAssessmentReviewRecord;
    status: 'accepted' | 'rejected';
    suggestionId: string;
    updatedAt: string;
  }): Promise<boolean>;
}
