export type CapabilityKind = 'ai' | 'ocr';

export const QUALITY_SUBJECTS = ['chinese', 'mathematics', 'english', 'science'] as const;
export const QUALITY_GRADE_BANDS = ['lower_primary', 'middle_primary', 'upper_primary'] as const;
export const QUALITY_QUESTION_TYPES = [
  'objective',
  'open_response',
  'process',
  'oral',
  'science_observation',
] as const;
export const QUALITY_IMAGE_QUALITIES = ['clear', 'degraded', 'unusable'] as const;
export const QUALITY_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const QUALITY_BASIS_STATES = ['current', 'conflicted', 'insufficient'] as const;

export type QualitySubject = (typeof QUALITY_SUBJECTS)[number];
export type QualityGradeBand = (typeof QUALITY_GRADE_BANDS)[number];
export type QualityQuestionType = (typeof QUALITY_QUESTION_TYPES)[number];
export type QualityImageQuality = (typeof QUALITY_IMAGE_QUALITIES)[number];
export type QualityRiskLevel = (typeof QUALITY_RISK_LEVELS)[number];
export type QualityBasisState = (typeof QUALITY_BASIS_STATES)[number];
export type SignoffRole = 'child_safety' | 'compliance' | 'domain_reviewer' | 'quality_owner';

export interface EvaluationSlice {
  basisState: QualityBasisState;
  gradeBand: QualityGradeBand;
  imageQuality: QualityImageQuality;
  questionType: QualityQuestionType;
  riskLevel: QualityRiskLevel;
  subject: QualitySubject;
}

export interface CapabilityUseSlice {
  basisState: QualityBasisState | 'not_applicable' | 'unclassified';
  gradeBand: QualityGradeBand | 'unclassified';
  imageQuality: QualityImageQuality | 'not_applicable' | 'unclassified';
  questionType: QualityQuestionType | 'unclassified';
  riskLevel: QualityRiskLevel | 'unclassified';
  subject: QualitySubject | 'unclassified';
}

export interface RequiredSlicePolicy {
  minimumSampleSize: number;
  registeredAt: string;
  requiredSignoffRoles: readonly SignoffRole[];
  requiredSlices: readonly EvaluationSlice[];
  version: string;
}

export interface EvaluationRun {
  capabilityVersionId: string;
  completedAt: string;
  evidenceHash: string;
  id: string;
  metrics: Readonly<Record<string, number>>;
  outcome: 'failed' | 'passed';
  policyVersion: string;
  sampleSize: number;
  slice: EvaluationSlice;
}

export type EvaluationSliceStatus = 'failed' | 'insufficient_evidence' | 'missing' | 'passed';

export interface QualityCard {
  capabilityVersionId: string;
  evidenceHash: string;
  policyVersion: string;
  slices: Array<{
    evaluationEvidenceHash: string | null;
    evaluationRunId: string | null;
    slice: EvaluationSlice;
    status: EvaluationSliceStatus;
  }>;
  status: 'failed' | 'incomplete' | 'passed';
}

export interface ReleaseSignoff {
  evidenceHash: string;
  policyVersion: string;
  signedAt: string;
  signer: { id: string; role: SignoffRole };
}

export interface CapabilityQualification {
  capabilityVersionId: string;
  evidenceHash: string;
  policyVersion: string;
  revision: number;
  signoffs: ReleaseSignoff[];
  status: 'pending' | 'signed';
}

export interface CapabilityVersion {
  readonly adapter: { readonly id: string; readonly version: string };
  readonly artifactHash: string;
  readonly capabilityKey: string;
  readonly id: string;
  readonly implementedBy: string;
  readonly kind: CapabilityKind;
  readonly modelOrEngine: { readonly id: string; readonly version: string };
  readonly policyVersion: string;
  readonly promptOrConfig: { readonly kind: 'config' | 'prompt'; readonly version: string };
  readonly provider: { readonly id: string; readonly version: string };
  readonly region: string;
  readonly registeredAt: string;
  readonly requiredSlicePolicyVersion: string;
  readonly templateVersion: string;
}

export type RolloutStage = 'disabled' | 'expanded' | 'general' | 'shadow' | 'small';

export interface RolloutState {
  allowedUseSlices: CapabilityUseSlice[];
  percentage: number;
  stage: RolloutStage;
  updatedAt: string;
}

export type ContainmentTarget =
  { id: string; kind: 'capability_version' } | { id: string; kind: 'provider' };

export interface ContainmentOrder {
  containedAt: string;
  epoch: number;
  id: string;
  reason: string;
  target: ContainmentTarget;
}

export interface ContainmentState {
  epoch: number;
  orders: ContainmentOrder[];
}

export interface CapabilityScope {
  capabilityKey: string;
  kind: CapabilityKind;
  slice: CapabilityUseSlice;
}

export interface CapabilityAuthorization {
  capabilityVersion: CapabilityVersion;
  rolloutStage: Exclude<RolloutStage, 'disabled'>;
}

export type DegradedReason =
  'CAPABILITY_CONTAINED' | 'NO_APPLICABLE_CAPABILITY' | 'NO_SIGNED_CAPABILITY' | 'OUTSIDE_ROLLOUT';

export interface AuthorizeCapabilityInput extends CapabilityScope {
  familySpaceId: string;
}

export interface AuthorizationDecision {
  containmentEpoch: number;
  decisionId: string;
  degradedReason: DegradedReason | null;
  issuedAt: string;
  primary: CapabilityAuthorization | null;
  rolloutBucket: number;
  scope: CapabilityScope;
  shadow: CapabilityAuthorization | null;
  status: 'authorized' | 'degraded';
}

export type AuthorizationPhase = 'after_receive' | 'before_publish' | 'before_send';
export type AuthorizationRoute = 'primary' | 'shadow';

export interface RevalidateAuthorizationInput {
  decisionId: string;
  expectedContainmentEpoch: number;
  phase: AuthorizationPhase;
  route: AuthorizationRoute;
}

export type AuthorizationRejectionReason =
  | 'AUTHORIZATION_STALE'
  | 'CAPABILITY_CONTAINED'
  | 'ROUTE_NOT_AUTHORIZED'
  | 'SHADOW_PUBLICATION_FORBIDDEN';

export type AuthorizationRevalidation =
  | {
      capabilityVersion: CapabilityVersion;
      containmentEpoch: number;
      decisionId: string;
      status: 'authorized';
    }
  | {
      containmentEpoch: number;
      decisionId: string;
      reason: AuthorizationRejectionReason;
      status: 'rejected';
    };

export interface CapabilityRecord {
  evaluationRuns: EvaluationRun[];
  revision: number;
  rollout: RolloutState;
  signoffs: ReleaseSignoff[];
  version: CapabilityVersion;
}

export interface QualityCommand {
  commandId: string;
}

export interface AdvanceRolloutInput extends QualityCommand {
  allowedUseSlices: readonly CapabilityUseSlice[];
  capabilityVersionId: string;
  changedAt: string;
  expectedRevision: number;
  percentage: number;
  stage: RolloutStage;
}

export interface ContainCapabilityInput extends QualityCommand {
  containedAt: string;
  expectedContainmentEpoch: number;
  reason: string;
  target: ContainmentTarget;
}

export interface RollbackCapabilityInput extends Omit<ContainCapabilityInput, 'target'> {
  authorization: AuthorizeCapabilityInput;
  failedCapabilityVersionId: string;
}

export interface ShadowObservation {
  capabilityVersionId: string;
  decisionId: string;
  id: string;
  inputHash: string;
  metrics: Readonly<Record<string, number>>;
  observedAt: string;
  outputHash: string;
}

export interface RecordShadowObservationInput extends QualityCommand {
  capabilityVersionId: string;
  decisionId: string;
  inputHash: string;
  metrics: Readonly<Record<string, number>>;
  observedAt: string;
  outputHash: string;
}
