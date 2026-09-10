import type {
  AuthorizationDecision,
  AuthorizationRevalidation,
  AuthorizeCapabilityInput,
  RevalidateAuthorizationInput,
} from '@rhea/quality-control';

import type { LearningBasisReader } from './service.js';
import type {
  OpenAssessmentModelResult,
  OpenAssessmentModelTask,
  OpenAssessmentTaskType,
  ResolvedOpenAssessmentInput,
} from './suggested-assessment.types.js';
import type { AssessmentActorReference, ObjectiveAssessmentInputReference } from './types.js';
import type { CurrentLearningBasisReference } from '@rhea/learning-content';

export interface OpenAssessmentInputReader {
  resolveOpenAssessmentInput(input: {
    actor: AssessmentActorReference;
    ageBand: OpenAssessmentModelTask['ageBand'];
    basis: CurrentLearningBasisReference;
    learningProfileId: string;
    materialId: string;
    reference: ObjectiveAssessmentInputReference;
    taskType: OpenAssessmentTaskType;
  }): Promise<ResolvedOpenAssessmentInput | null>;
}

export interface OpenAssessmentModelGatewayPort {
  runStructured(task: OpenAssessmentModelTask): Promise<OpenAssessmentModelResult>;
}

export interface OpenAssessmentQualityControlPort {
  authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision>;
  revalidateAuthorization(input: RevalidateAuthorizationInput): Promise<AuthorizationRevalidation>;
}

export interface OpenAssessmentPublicationGate {
  authorize(input: {
    ageBand: OpenAssessmentModelTask['ageBand'];
    consentRevision: number;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<boolean>;
}

export type OpenAssessmentBasisReader = LearningBasisReader;
