import type {
  AuthorizationDecision,
  AuthorizationRevalidation,
  AuthorizeCapabilityInput,
  RevalidateAuthorizationInput,
} from '@rhea/quality-control';

import type {
  ReviewCardAgeBand,
  ReviewCardModelResult,
  ReviewCardModelTask,
} from './review-card-types.js';

export interface ReviewCardModelGatewayPort {
  runStructured(task: ReviewCardModelTask): Promise<ReviewCardModelResult>;
}

export interface ReviewCardPublicationGate {
  authorize(input: {
    ageBand: ReviewCardAgeBand;
    consentRevision: number;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<boolean>;
}

export interface ReviewCardQualityControlPort {
  authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision>;
  revalidateAuthorization(input: RevalidateAuthorizationInput): Promise<AuthorizationRevalidation>;
}
