import { randomUUID } from 'node:crypto';

import type { MetricsGovernanceStore } from './store.js';
import type {
  LearningMetricEvent,
  MetricDefinition,
  MetricsGovernanceAuditRecord,
  MetricsOperationContext,
  ReadinessEvidence,
  ReadinessEvidenceKey,
  ReadinessReport,
} from './types.js';

const READINESS_KEYS: ReadinessEvidenceKey[] = [
  'child_safety_response',
  'core_learning_flow',
  'disaster_recovery',
  'guardian_support_flow',
  'learning_outcome_threshold',
  'mobile_usability',
  'performance_capacity',
  'privacy_erasure',
  'provider_quality',
  'shanghai_compliance_package',
];

function required(value: string, label: string) {
  const result = value.trim();
  if (!result || result.length > 500) throw new Error(`${label}无效`);
  return result;
}

function missing(keys: ReadinessEvidenceKey[], map: Map<ReadinessEvidenceKey, ReadinessEvidence>) {
  return keys.filter((key) => !map.get(key)?.passed);
}

export class MetricsGovernanceService {
  constructor(readonly store: MetricsGovernanceStore) {}

  async registerMetric(definition: MetricDefinition, context?: MetricsOperationContext) {
    if (
      !Number.isInteger(definition.windowDays) ||
      definition.windowDays < 1 ||
      !Number.isInteger(definition.retentionDays) ||
      definition.retentionDays < definition.windowDays ||
      !definition.exclusions.length
    )
      throw new Error('指标登记必须包含窗口、保留和排除规则');
    const checked = {
      ...definition,
      key: required(definition.key, '指标键'),
      version: required(definition.version, '指标版本'),
      numerator: required(definition.numerator, '分子'),
      denominator: required(definition.denominator, '分母'),
      owner: required(definition.owner, '责任人'),
      exclusions: definition.exclusions.map((item) => required(item, '排除规则')),
    };
    const result = context
      ? await this.store.registerMetricWithAudit(
          checked,
          this.#auditRecord(context, 'metric.register', `${checked.key}:${checked.version}`),
        )
      : await this.store.registerMetric(checked);
    if (result === 'conflict') throw new Error('指标版本定义冲突');
    return result;
  }

  async recordLearningEvent(event: LearningMetricEvent) {
    if (!Number.isFinite(Date.parse(event.occurredAt)) || !event.version || !event.source.version)
      throw new Error('学习事件缺少版本或来源');
    const result = await this.store.recordMetricEvent({
      ...event,
      eventKey: required(event.eventKey, '事件键'),
      eventType: required(event.eventType, '事件类型'),
    });
    if (result === 'conflict') throw new Error('学习事件幂等键冲突');
    if (result === 'erased_subject') throw new Error('已删除学习档案不得重新写入指标');
    return result;
  }

  async countEligibleEvents() {
    const events = await this.store.listMetricEvents();
    return events.filter((event) => event.authorityState === 'accepted_current').length;
  }

  async transitionLearningEventsAuthority(input: {
    authorityState: 'disputed' | 'expired' | 'invalidated';
    eventKeys: string[];
  }) {
    const eventKeys = [...new Set(input.eventKeys.map((key) => required(key, '事件键')))];
    return this.store.transitionMetricEventAuthority({
      authorityState: input.authorityState,
      eventKeys,
    });
  }

  async evaluateProviderQualityReadiness(context: MetricsOperationContext) {
    const evaluationId = randomUUID();
    return this.store.evaluateProviderQualityReadiness(
      evaluationId,
      this.#auditRecord(context, 'provider_quality.evaluate', evaluationId),
    );
  }

  async getProviderQualityReadiness() {
    return this.store.findLatestProviderQualityReadiness();
  }

  async saveReadinessEvidence(value: ReadinessEvidence, context: MetricsOperationContext) {
    if (!READINESS_KEYS.includes(value.key)) throw new Error('准入证据键无效');
    if (value.key === 'provider_quality')
      throw new Error('供应商质量准入只能由当前发布质量状态生成');
    const checked: ReadinessEvidence = {
      ...value,
      reference: value.passed ? required(value.reference, '证据引用') : value.reference.trim(),
      signedBy: value.passed ? required(context.actorId, '操作人员') : null,
    };
    await this.store.saveReadinessEvidence(
      checked,
      this.#auditRecord(context, 'readiness.record', value.key),
    );
  }

  async getReadiness(): Promise<ReadinessReport> {
    const map = new Map(
      (await this.store.listReadinessEvidence()).map((value) => [value.key, value]),
    );
    const development: ReadinessEvidenceKey[] = ['core_learning_flow'];
    const pilot: ReadinessEvidenceKey[] = [
      ...development,
      'child_safety_response',
      'guardian_support_flow',
      'privacy_erasure',
      'provider_quality',
    ];
    const usable: ReadinessEvidenceKey[] = [
      ...pilot,
      'mobile_usability',
      'performance_capacity',
      'disaster_recovery',
    ];
    const success: ReadinessEvidenceKey[] = [...usable, 'learning_outcome_threshold'];
    const result = {
      developmentComplete: { missing: missing(development, map) },
      familyPilotReady: { missing: missing(pilot, map) },
      mvpUsable: { missing: missing(usable, map) },
      learningSuccess: { missing: missing(success, map) },
    };
    return {
      developmentComplete: {
        ...result.developmentComplete,
        achieved: !result.developmentComplete.missing.length,
      },
      familyPilotReady: {
        ...result.familyPilotReady,
        achieved: !result.familyPilotReady.missing.length,
      },
      mvpUsable: { ...result.mvpUsable, achieved: !result.mvpUsable.missing.length },
      learningSuccess: {
        ...result.learningSuccess,
        achieved: !result.learningSuccess.missing.length,
      },
      publicReleaseAllowed: false,
    };
  }

  #auditRecord(
    context: MetricsOperationContext,
    action: MetricsGovernanceAuditRecord['action'],
    target: string,
  ): MetricsGovernanceAuditRecord {
    return {
      action,
      actorId: required(context.actorId, '操作人员'),
      occurredAt: new Date().toISOString(),
      reason: required(context.reason, '操作原因'),
      target,
    };
  }
}
