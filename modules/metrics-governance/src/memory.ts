import type { MetricsGovernanceStore } from './store.js';
import type {
  LearningMetricEvent,
  MetricDefinition,
  MetricsGovernanceAuditRecord,
  ProviderQualityReadinessEvaluation,
  ProviderQualityReleaseSnapshot,
  ReadinessEvidence,
} from './types.js';

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class MemoryMetricsGovernanceStore implements MetricsGovernanceStore {
  readonly definitions = new Map<string, MetricDefinition>();
  readonly events = new Map<string, LearningMetricEvent>();
  readonly evidence = new Map<string, ReadinessEvidence>();
  readonly audits: MetricsGovernanceAuditRecord[] = [];
  readonly providerQualityEvaluations: ProviderQualityReadinessEvaluation[] = [];

  constructor(readonly authoritativeReleases: ProviderQualityReleaseSnapshot[] = []) {}

  async evaluateProviderQualityReadiness(
    evaluationId: string,
    audit: MetricsGovernanceAuditRecord,
  ) {
    const releases = structuredClone(this.authoritativeReleases);
    const active = releases.filter(({ stage }) => ['small', 'expanded', 'general'].includes(stage));
    const reasons: string[] = [];
    if (!active.some(({ kind }) => kind === 'ocr')) reasons.push('缺少当前启用的 OCR 发布');
    if (!active.some(({ kind }) => kind === 'ai')) reasons.push('缺少当前启用的 AI 发布');
    for (const release of active) {
      if (!release.capabilityVersionId || release.qualityStatus !== 'passed' || !release.signed) {
        reasons.push(`当前发布未完成质量签署:${release.kind}:${release.capabilityKey}`);
      }
    }
    const evaluation: ProviderQualityReadinessEvaluation = {
      evaluatedAt: audit.occurredAt,
      id: evaluationId,
      passed: reasons.length === 0,
      reasons,
      releases,
    };
    this.providerQualityEvaluations.push(structuredClone(evaluation));
    this.evidence.set('provider_quality', {
      key: 'provider_quality',
      passed: evaluation.passed,
      reference: `quality-readiness:${evaluationId}`,
      signedBy: evaluation.passed ? 'authoritative-quality-control' : null,
    });
    this.audits.push(structuredClone(audit));
    return structuredClone(evaluation);
  }

  async findLatestProviderQualityReadiness() {
    return structuredClone(this.providerQualityEvaluations.at(-1) ?? null);
  }

  async getMetricDefinition(key: string, version: string) {
    return structuredClone(this.definitions.get(`${key}:${version}`) ?? null);
  }

  async registerMetric(value: MetricDefinition) {
    const key = `${value.key}:${value.version}`;
    const existing = this.definitions.get(key);
    if (existing) return same(existing, value) ? ('replayed' as const) : ('conflict' as const);
    this.definitions.set(key, structuredClone(value));
    return 'recorded' as const;
  }

  async registerMetricWithAudit(value: MetricDefinition, audit: MetricsGovernanceAuditRecord) {
    const result = await this.registerMetric(value);
    this.audits.push(structuredClone(audit));
    return result;
  }

  async recordMetricEvent(value: LearningMetricEvent) {
    const existing = this.events.get(value.eventKey);
    if (existing) {
      const incoming =
        ['disputed', 'expired', 'invalidated'].includes(existing.authorityState) &&
        value.authorityState === 'accepted_current'
          ? { ...value, authorityState: existing.authorityState }
          : value;
      return same(existing, incoming) ? ('replayed' as const) : ('conflict' as const);
    }
    this.events.set(value.eventKey, structuredClone(value));
    return 'recorded' as const;
  }

  async listMetricEvents() {
    return structuredClone([...this.events.values()]);
  }

  async transitionMetricEventAuthority(input: {
    authorityState: 'disputed' | 'expired' | 'invalidated';
    eventKeys: string[];
  }) {
    let updated = 0;
    for (const eventKey of input.eventKeys) {
      const event = this.events.get(eventKey);
      if (!event) continue;
      if (
        ['disputed', 'expired', 'invalidated'].includes(event.authorityState) &&
        event.authorityState !== input.authorityState
      )
        continue;
      event.authorityState = input.authorityState;
      updated += 1;
    }
    return updated;
  }

  async saveReadinessEvidence(value: ReadinessEvidence, audit: MetricsGovernanceAuditRecord) {
    this.evidence.set(value.key, structuredClone(value));
    this.audits.push(structuredClone(audit));
  }

  async listReadinessEvidence() {
    return structuredClone([...this.evidence.values()]);
  }
}
