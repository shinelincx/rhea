import type {
  AssessmentActorReference,
  AssessmentDispute,
  AssessmentDisputeResolution,
  DownstreamAssessmentReference,
  ObjectiveAssessmentVersion,
  StoredObjectiveAssessment,
} from './types.js';
import type { CurrentLearningBasisReference } from '@rhea/learning-content';

export type DownstreamAssessmentRead =
  | { kind: 'basis_changed' }
  | { kind: 'ineligible'; reason: 'disputed' | 'ungradable' }
  | { kind: 'not_found' }
  | { kind: 'eligible'; reference: DownstreamAssessmentReference };

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
  readDownstreamReference(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    currentBasis: CurrentLearningBasisReference;
    learningProfileId: string;
  }): Promise<DownstreamAssessmentRead>;
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
