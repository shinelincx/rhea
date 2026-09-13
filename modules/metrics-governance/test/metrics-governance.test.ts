import { describe, expect, it } from 'vitest';

import {
  MemoryMetricsGovernanceStore,
  MetricsGovernanceService,
  type LearningMetricEvent,
  type ProviderQualityReleaseSnapshot,
  type ReadinessEvidence,
} from '../src/index.js';

const event: LearningMetricEvent = {
  authorityState: 'accepted_current',
  eventKey: 'assessment-1:v1',
  eventType: 'objective_assessment.accepted',
  familySpaceId: 'family-1',
  learningProfileId: 'profile-1',
  occurredAt: '2026-09-13T08:00:00.000Z',
  payload: { correct: true },
  source: { aggregateId: 'assessment-1', aggregateType: 'objective_assessment', version: '1' },
  version: 'learning-event-v1',
};

const operation = (actorId = 'metrics-operator') => ({ actorId, reason: '测试操作' });

function evidence(key: ReadinessEvidence['key']): ReadinessEvidence {
  return { key, passed: true, reference: `evidence://${key}`, signedBy: null };
}

function signedRelease(
  kind: ProviderQualityReleaseSnapshot['kind'],
): ProviderQualityReleaseSnapshot {
  return {
    capabilityKey: kind === 'ocr' ? 'submission-ocr' : 'learning-explanation',
    capabilityVersionId: `${kind}-version-1`,
    kind,
    qualityCardId: `${kind}-card-1`,
    qualityEvidenceHash: 'a'.repeat(64),
    qualityStatus: 'passed',
    releaseId: `${kind}-release-1`,
    signed: true,
    stage: 'small',
  };
}

describe('MetricsGovernanceService', () => {
  it('registers explicit metric semantics and deduplicates versioned learning events', async () => {
    const service = new MetricsGovernanceService(new MemoryMetricsGovernanceStore());
    const definition = {
      denominator: 'all accepted current objective assessments',
      exclusions: ['pending', 'disputed', 'expired', 'shadow'],
      key: 'objective_accuracy',
      numerator: 'accepted current correct assessments',
      owner: 'learning-quality-owner',
      retentionDays: 180,
      version: 'v1',
      windowDays: 30,
    };
    await expect(service.registerMetric(definition)).resolves.toBe('recorded');
    await expect(service.registerMetric(definition)).resolves.toBe('replayed');
    await expect(service.registerMetric({ ...definition, numerator: 'changed' })).rejects.toThrow(
      '指标版本定义冲突',
    );
    await expect(service.recordLearningEvent(event)).resolves.toBe('recorded');
    await expect(service.recordLearningEvent(event)).resolves.toBe('replayed');
    await service.recordLearningEvent({
      ...event,
      authorityState: 'pending',
      eventKey: 'assessment-2:v1',
    });
    expect(await service.countEligibleEvents()).toBe(1);
  });

  it('derives provider readiness only from current signed T09 release snapshots', async () => {
    const store = new MemoryMetricsGovernanceStore([signedRelease('ocr'), signedRelease('ai')]);
    const service = new MetricsGovernanceService(store);
    const evaluation = await service.evaluateProviderQualityReadiness(operation('release-manager'));
    expect(evaluation).toMatchObject({ passed: true, reasons: [] });
    expect(await service.getProviderQualityReadiness()).toEqual(evaluation);
    expect(store.evidence.get('provider_quality')).toMatchObject({
      passed: true,
      reference: `quality-readiness:${evaluation.id}`,
      signedBy: 'authoritative-quality-control',
    });
    expect(store.audits).toEqual([
      expect.objectContaining({
        action: 'provider_quality.evaluate',
        actorId: 'release-manager',
        target: evaluation.id,
      }),
    ]);
  });

  it('blocks readiness when an active OCR or AI release is missing or unsigned', async () => {
    const unsigned = { ...signedRelease('ocr'), signed: false };
    const service = new MetricsGovernanceService(new MemoryMetricsGovernanceStore([unsigned]));
    const evaluation = await service.evaluateProviderQualityReadiness(operation('release-manager'));
    expect(evaluation.passed).toBe(false);
    expect(evaluation.reasons).toEqual(
      expect.arrayContaining([
        '缺少当前启用的 AI 发布',
        '当前发布未完成质量签署:ocr:submission-ocr',
      ]),
    );
    await expect(
      service.saveReadinessEvidence(evidence('provider_quality'), operation('release-manager')),
    ).rejects.toThrow('供应商质量准入只能由当前发布质量状态生成');
  });

  it('keeps development, family pilot, MVP, learning success and public release separate', async () => {
    const service = new MetricsGovernanceService(
      new MemoryMetricsGovernanceStore([signedRelease('ocr'), signedRelease('ai')]),
    );
    await service.saveReadinessEvidence(evidence('core_learning_flow'), operation('release'));
    expect(await service.getReadiness()).toMatchObject({
      developmentComplete: { achieved: true },
      familyPilotReady: { achieved: false },
      publicReleaseAllowed: false,
    });
    await service.evaluateProviderQualityReadiness(operation('release'));
    for (const key of [
      'child_safety_response',
      'guardian_support_flow',
      'privacy_erasure',
      'mobile_usability',
      'performance_capacity',
      'disaster_recovery',
      'learning_outcome_threshold',
      'shanghai_compliance_package',
    ] as const) {
      await service.saveReadinessEvidence(evidence(key), operation('release'));
    }
    expect(await service.getReadiness()).toMatchObject({
      familyPilotReady: { achieved: true },
      learningSuccess: { achieved: true },
      mvpUsable: { achieved: true },
      publicReleaseAllowed: false,
    });
  });

  it('keeps terminal authority transitions monotonic when an accepted event is replayed late', async () => {
    const store = new MemoryMetricsGovernanceStore();
    const service = new MetricsGovernanceService(store);
    await service.recordLearningEvent(event);
    await service.transitionLearningEventsAuthority({
      authorityState: 'invalidated',
      eventKeys: [event.eventKey],
    });
    await expect(service.recordLearningEvent(event)).resolves.toBe('replayed');
    await service.transitionLearningEventsAuthority({
      authorityState: 'disputed',
      eventKeys: [event.eventKey],
    });
    expect(await store.listMetricEvents()).toEqual([
      expect.objectContaining({ authorityState: 'invalidated' }),
    ]);
    expect(await service.countEligibleEvents()).toBe(0);
  });
});
