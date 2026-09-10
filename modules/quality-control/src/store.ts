import type {
  AuthorizationDecision,
  AuthorizationRevalidation,
  CapabilityKind,
  CapabilityRecord,
  ContainmentOrder,
  ContainmentState,
  RequiredSlicePolicy,
  RevalidateAuthorizationInput,
  ShadowObservation,
} from './types.js';

export interface QualityCommandReceipt {
  aggregateId: string;
  commandId: string;
  fingerprint: string;
}

export type CapabilityMutation = 'evaluation' | 'rollout' | 'signoff';

export interface AuthorizationDecisionGuard {
  capabilityRevisions: Array<{ id: string; revision: number }>;
  containmentEpoch: number;
  /** SHA-256 of the private family-space identifier used for the rollout bucket. */
  familySpaceHash: string;
}

export interface ContainmentSaveGuard {
  containmentEpoch: number;
  rollback?: {
    decisionId: string;
    primaryVersionId: string;
  };
}

export type AuthorizationDecisionSaveResult =
  { decision: AuthorizationDecision; status: 'saved' } | { status: 'conflict' };

export interface AuthorizationRevalidationSnapshot {
  containment: ContainmentState;
  decision: AuthorizationDecision | null;
  records: CapabilityRecord[];
  slicePolicies: RequiredSlicePolicy[];
}

export interface QualityControlStore {
  createCapability(
    record: CapabilityRecord,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'>;
  createSlicePolicy(
    policy: RequiredSlicePolicy,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'>;
  createShadowObservation(
    observation: ShadowObservation,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'>;
  findCapability(id: string): Promise<CapabilityRecord | null>;
  findAuthorizationDecision(id: string): Promise<AuthorizationDecision | null>;
  findCommand(commandId: string): Promise<QualityCommandReceipt | null>;
  findContainmentState(): Promise<ContainmentState>;
  findSlicePolicy(version: string): Promise<RequiredSlicePolicy | null>;
  findShadowObservation(id: string): Promise<ShadowObservation | null>;
  listCapabilities(capabilityKey: string, kind: CapabilityKind): Promise<CapabilityRecord[]>;
  /** Atomically compare the global containment epoch and the complete scoped revision set, then persist. */
  saveAuthorizationDecision(
    decision: AuthorizationDecision,
    guard: AuthorizationDecisionGuard,
  ): Promise<AuthorizationDecisionSaveResult>;
  saveContainmentOrder(
    order: ContainmentOrder,
    guard: ContainmentSaveGuard,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'duplicate' | 'saved'>;
  /** Run the synchronous inspector while the decision, containment state, routes, and policies are locked. */
  revalidateAuthorizationAtomically(
    input: RevalidateAuthorizationInput,
    inspect: (snapshot: AuthorizationRevalidationSnapshot) => AuthorizationRevalidation,
  ): Promise<AuthorizationRevalidation>;
  saveCapability(
    record: CapabilityRecord,
    expectedRevision: number,
    receipt: QualityCommandReceipt,
    /** Adapters must also reject any mixed or mismatched mutation. */
    mutation: CapabilityMutation,
  ): Promise<'conflict' | 'duplicate' | 'saved'>;
}
