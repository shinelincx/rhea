import type {
  AssessmentDispute,
  AssessmentDisputeResolution,
  ObjectiveAssessmentVersion,
  StoredObjectiveAssessment,
} from './types.js';

export interface AssessmentStore {
  appendDispute(input: {
    assessmentId: string;
    dispute: AssessmentDispute;
    expectedCurrentVersionId: string;
    learningProfileId: string;
  }): Promise<boolean>;
  createAssessment(assessment: StoredObjectiveAssessment): Promise<boolean>;
  findAssessment(id: string, learningProfileId: string): Promise<StoredObjectiveAssessment | null>;
  findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredObjectiveAssessment | null>;
  recordAccess(input: {
    action: string;
    actor: { id: string; type: 'guardian' | 'learner' };
    assessmentId: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<void>;
  resolveDispute(input: {
    assessmentId: string;
    expectedCurrentVersionId: string;
    expectedOpenDisputeId: string;
    learningProfileId: string;
    resolution: AssessmentDisputeResolution;
    version: ObjectiveAssessmentVersion;
  }): Promise<boolean>;
}
