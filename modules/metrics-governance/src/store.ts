import type {
  LearningMetricEvent,
  MetricDefinition,
  MetricsGovernanceAuditRecord,
  ProviderQualityReadinessEvaluation,
  ReadinessEvidence,
} from './types.js';

export interface MetricsGovernanceStore {
  evaluateProviderQualityReadiness(
    evaluationId: string,
    audit: MetricsGovernanceAuditRecord,
  ): Promise<ProviderQualityReadinessEvaluation>;
  findLatestProviderQualityReadiness(): Promise<ProviderQualityReadinessEvaluation | null>;
  getMetricDefinition(key: string, version: string): Promise<MetricDefinition | null>;
  listMetricEvents(): Promise<LearningMetricEvent[]>;
  listReadinessEvidence(): Promise<ReadinessEvidence[]>;
  recordMetricEvent(
    event: LearningMetricEvent,
  ): Promise<'conflict' | 'erased_subject' | 'recorded' | 'replayed'>;
  registerMetric(definition: MetricDefinition): Promise<'conflict' | 'recorded' | 'replayed'>;
  registerMetricWithAudit(
    definition: MetricDefinition,
    audit: MetricsGovernanceAuditRecord,
  ): Promise<'conflict' | 'recorded' | 'replayed'>;
  saveReadinessEvidence(
    evidence: ReadinessEvidence,
    audit: MetricsGovernanceAuditRecord,
  ): Promise<void>;
  transitionMetricEventAuthority(input: {
    authorityState: 'disputed' | 'expired' | 'invalidated';
    eventKeys: string[];
  }): Promise<number>;
}
