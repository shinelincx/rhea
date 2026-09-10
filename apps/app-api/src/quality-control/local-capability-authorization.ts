import { createHash } from 'node:crypto';

import type {
  AuthorizationDecision,
  AuthorizationRevalidation,
  AuthorizeCapabilityInput,
  CapabilityVersion,
  RevalidateAuthorizationInput,
} from '@rhea/quality-control';

export interface LocalCapabilityAuthorization {
  authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision>;
  revalidateAuthorization(input: RevalidateAuthorizationInput): Promise<AuthorizationRevalidation>;
}

function stableDecisionId(input: AuthorizeCapabilityInput): string {
  return `local-${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

/** Explicit non-production/test authority. Missing or mismatched versions degrade closed. */
export function createLocalCapabilityAuthorization(
  capability: CapabilityVersion | null,
): LocalCapabilityAuthorization {
  const decisions = new Map<string, AuthorizationDecision>();

  return {
    async authorizeCapability(input) {
      const decisionId = stableDecisionId(input);
      const existing = decisions.get(decisionId);
      if (existing) return structuredClone(existing);
      const approved =
        capability?.capabilityKey === input.capabilityKey && capability.kind === input.kind;
      const decision: AuthorizationDecision = {
        containmentEpoch: 1,
        decisionId,
        degradedReason: approved ? null : 'NO_SIGNED_CAPABILITY',
        issuedAt: new Date().toISOString(),
        primary: approved
          ? { capabilityVersion: structuredClone(capability), rolloutStage: 'general' }
          : null,
        rolloutBucket:
          Number.parseInt(
            createHash('sha256').update(input.familySpaceId).digest('hex').slice(0, 8),
            16,
          ) % 100,
        scope: {
          capabilityKey: input.capabilityKey,
          kind: input.kind,
          slice: structuredClone(input.slice),
        },
        shadow: null,
        status: approved ? 'authorized' : 'degraded',
      };
      decisions.set(decisionId, structuredClone(decision));
      return decision;
    },

    async revalidateAuthorization(input) {
      const decision = decisions.get(input.decisionId);
      if (!decision || decision.containmentEpoch !== input.expectedContainmentEpoch) {
        return {
          containmentEpoch: decision?.containmentEpoch ?? input.expectedContainmentEpoch,
          decisionId: input.decisionId,
          reason: 'AUTHORIZATION_STALE',
          status: 'rejected',
        };
      }
      if (input.route !== 'primary' || !decision.primary) {
        return {
          containmentEpoch: decision.containmentEpoch,
          decisionId: decision.decisionId,
          reason:
            input.route === 'shadow' && input.phase === 'before_publish'
              ? 'SHADOW_PUBLICATION_FORBIDDEN'
              : 'ROUTE_NOT_AUTHORIZED',
          status: 'rejected',
        };
      }
      return {
        capabilityVersion: structuredClone(decision.primary.capabilityVersion),
        containmentEpoch: decision.containmentEpoch,
        decisionId: decision.decisionId,
        status: 'authorized',
      };
    },
  };
}
