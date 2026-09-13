export type MetricAuthorityState =
  'accepted_current' | 'disputed' | 'expired' | 'invalidated' | 'pending' | 'shadow';

export interface MetricDefinition {
  denominator: string;
  exclusions: string[];
  key: string;
  numerator: string;
  owner: string;
  retentionDays: number;
  version: string;
  windowDays: number;
}

export interface LearningMetricEvent {
  authorityState: MetricAuthorityState;
  eventKey: string;
  eventType: string;
  familySpaceId: string;
  learningProfileId: string;
  occurredAt: string;
  payload: Record<string, boolean | number | string | null>;
  source: { aggregateId: string; aggregateType: string; version: string };
  version: string;
}

export interface ProviderQualityReleaseSnapshot {
  capabilityKey: string;
  capabilityVersionId: string | null;
  kind: 'ai' | 'ocr';
  qualityCardId: string | null;
  qualityEvidenceHash: string | null;
  qualityStatus: 'failed' | 'incomplete' | 'passed' | null;
  releaseId: string | null;
  signed: boolean;
  stage: 'disabled' | 'expanded' | 'general' | 'shadow' | 'small';
}

export interface ProviderQualityReadinessEvaluation {
  evaluatedAt: string;
  id: string;
  passed: boolean;
  reasons: string[];
  releases: ProviderQualityReleaseSnapshot[];
}

export type ReadinessEvidenceKey =
  | 'child_safety_response'
  | 'core_learning_flow'
  | 'disaster_recovery'
  | 'guardian_support_flow'
  | 'learning_outcome_threshold'
  | 'mobile_usability'
  | 'performance_capacity'
  | 'privacy_erasure'
  | 'provider_quality'
  | 'shanghai_compliance_package';

export interface ReadinessEvidence {
  key: ReadinessEvidenceKey;
  passed: boolean;
  reference: string;
  signedBy: string | null;
}

export interface ReadinessReport {
  developmentComplete: { achieved: boolean; missing: ReadinessEvidenceKey[] };
  familyPilotReady: { achieved: boolean; missing: ReadinessEvidenceKey[] };
  learningSuccess: { achieved: boolean; missing: ReadinessEvidenceKey[] };
  mvpUsable: { achieved: boolean; missing: ReadinessEvidenceKey[] };
  publicReleaseAllowed: boolean;
}

export interface MetricsOperationContext {
  actorId: string;
  reason: string;
}

export interface MetricsGovernanceAuditRecord extends MetricsOperationContext {
  action: 'metric.register' | 'provider_quality.evaluate' | 'readiness.record';
  occurredAt: string;
  target: string;
}
