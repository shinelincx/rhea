import type { CurrentLearningContextReference } from '@rhea/learning-content';
import type {
  AuthorizationDecision,
  AuthorizationRevalidation,
  AuthorizeCapabilityInput,
  RevalidateAuthorizationInput,
} from '@rhea/quality-control';

import type { ModelTask, ModelTaskResult } from './types.js';
import type { AgeBand } from './types.js';

export interface ModelGatewayPort {
  runStructured(task: ModelTask): Promise<ModelTaskResult>;
}

export interface CurrentGenerationBasisReader {
  getCurrentLearningContextReference(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    learningProfileId: string;
    materialId: string;
  }): Promise<CurrentLearningContextReference>;
}

export interface GenerationPublicationGate {
  authorize(input: {
    ageBand: AgeBand;
    consentRevision: number;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<boolean>;
}

export interface GenerationQualityControlPort {
  authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision>;
  revalidateAuthorization(input: RevalidateAuthorizationInput): Promise<AuthorizationRevalidation>;
}
