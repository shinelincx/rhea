import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MemoryMetricsGovernanceStore, MetricsGovernanceService } from '@rhea/metrics-governance';
import { MemorySafetyEscalationStore, SafetyEscalationService } from '@rhea/safety-escalation';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('audited operations HTTP interface', () => {
  let app: NestFastifyApplication | undefined;
  const originalTokens = process.env.OPERATIONS_PRINCIPAL_TOKENS;
  const originalRoles = process.env.OPERATIONS_PRINCIPAL_ROLES;

  afterEach(async () => {
    if (originalTokens === undefined) delete process.env.OPERATIONS_PRINCIPAL_TOKENS;
    else process.env.OPERATIONS_PRINCIPAL_TOKENS = originalTokens;
    if (originalRoles === undefined) delete process.env.OPERATIONS_PRINCIPAL_ROLES;
    else process.env.OPERATIONS_PRINCIPAL_ROLES = originalRoles;
    await app?.close();
  });

  it('operates recoverable safety cases and derives provider/readiness gates', async () => {
    const principals = {
      'child-safety': 'child-safety-token-000000000001',
      'domain-reviewer': 'domain-review-token-00000000001',
      'metrics-operator': 'metrics-operator-token-00000001',
      'quality-owner': 'quality-owner-token-00000000001',
      'release-manager': 'release-manager-token-000000001',
      'safety-operator': 'safety-operator-token-000000001',
    };
    process.env.OPERATIONS_PRINCIPAL_TOKENS = JSON.stringify(principals);
    process.env.OPERATIONS_PRINCIPAL_ROLES = JSON.stringify({
      'child-safety': 'child_safety',
      'domain-reviewer': 'domain_reviewer',
      'metrics-operator': 'metrics_operator',
      'quality-owner': 'quality_owner',
      'release-manager': 'release_manager',
      'safety-operator': 'safety_operator',
    });
    const headers = (principal: keyof typeof principals) => ({
      'x-rhea-operator-id': principal,
      'x-rhea-operator-token': principals[principal],
    });
    const safetyStore = new MemorySafetyEscalationStore();
    const safety = new SafetyEscalationService(safetyStore, {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    const safetyCase = await safety.classify({
      content: '有人威胁我私下见面',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      source: 'challenge_event',
      sourceReferenceId: 'report-1',
    });
    let mappingResolutionInput: unknown;
    const safetyOperations = Object.assign(safety, {
      async resolveChallengeReportSubjects(input: unknown) {
        mappingResolutionInput = input;
        return [
          {
            familySpaceId: 'family-1',
            learningProfileId: 'profile-1',
            mappingRole: 'reporter' as const,
            subjectToken: 'a'.repeat(64),
          },
        ];
      },
    });
    const metricsStore = new MemoryMetricsGovernanceStore([
      {
        capabilityKey: 'submission-ocr',
        capabilityVersionId: 'ocr-v1',
        kind: 'ocr',
        qualityCardId: 'ocr-card-1',
        qualityEvidenceHash: 'a'.repeat(64),
        qualityStatus: 'passed',
        releaseId: 'ocr-release-1',
        signed: true,
        stage: 'small',
      },
      {
        capabilityKey: 'learning-explanation',
        capabilityVersionId: 'ai-v1',
        kind: 'ai',
        qualityCardId: 'ai-card-1',
        qualityEvidenceHash: 'b'.repeat(64),
        qualityStatus: 'passed',
        releaseId: 'ai-release-1',
        signed: true,
        stage: 'small',
      },
    ]);
    const metrics = new MetricsGovernanceService(metricsStore);
    app = await createApp({
      dependencyProbes: [],
      metricsGovernanceService: metrics,
      safetyEscalationService: safety,
      safetyOperationsService: safetyOperations,
    });
    await app.init();

    const denied = await app.inject({
      method: 'POST',
      payload: { action: 'escalation_failed', reason: '通道失败' },
      url: `/internal/operations/safety-cases/${safetyCase.caseId}/actions`,
    });
    expect(denied.statusCode).toBe(401);
    const queue = await app.inject({
      headers: {
        ...headers('safety-operator'),
        'x-rhea-operation-reason': '读取待处置安全个案',
      },
      method: 'GET',
      url: '/internal/operations/safety-cases',
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data).toEqual([
      expect.objectContaining({ id: safetyCase.caseId, notificationStatus: 'pending' }),
    ]);
    for (const [action, reason, commandId] of [
      ['claim', '领取待处置安全个案', '00000000-0000-4000-8000-000000000021'],
      ['escalation_failed', '人工升级通道失败', '00000000-0000-4000-8000-000000000022'],
      ['retry_started', '通道恢复后开始重试', '00000000-0000-4000-8000-000000000023'],
      ['false_positive', '复核确认是语境误报', '00000000-0000-4000-8000-000000000024'],
    ] as const) {
      const response = await app.inject({
        headers: { ...headers('safety-operator'), 'idempotency-key': commandId },
        method: 'POST',
        payload: { action, reason },
        url: `/internal/operations/safety-cases/${safetyCase.caseId}/actions`,
      });
      expect(response.statusCode).toBe(201);
    }
    expect(safetyStore.cases.get(safetyCase.caseId!)?.status).toBe('closed_false_positive');
    const resolvedSubjects = await app.inject({
      headers: {
        ...headers('safety-operator'),
        'x-rhea-operation-reason': '调查严重挑战举报',
      },
      method: 'GET',
      url: '/internal/operations/safety-reports/00000000-0000-4000-8000-000000000031/subjects',
    });
    expect(resolvedSubjects.statusCode).toBe(200);
    expect(resolvedSubjects.json().data).toEqual([
      expect.objectContaining({ learningProfileId: 'profile-1', mappingRole: 'reporter' }),
    ]);
    expect(mappingResolutionInput).toMatchObject({
      operatorId: 'safety-operator',
      reason: '调查严重挑战举报',
      reportId: '00000000-0000-4000-8000-000000000031',
    });

    const slices = [
      {
        basisState: 'current',
        gradeBand: 'lower_primary',
        imageQuality: 'clear',
        questionType: 'objective',
        riskLevel: 'low',
        subject: 'chinese',
      },
      {
        basisState: 'conflicted',
        gradeBand: 'middle_primary',
        imageQuality: 'degraded',
        questionType: 'open_response',
        riskLevel: 'medium',
        subject: 'mathematics',
      },
      {
        basisState: 'insufficient',
        gradeBand: 'upper_primary',
        imageQuality: 'unusable',
        questionType: 'process',
        riskLevel: 'high',
        subject: 'english',
      },
      {
        basisState: 'current',
        gradeBand: 'lower_primary',
        imageQuality: 'clear',
        questionType: 'oral',
        riskLevel: 'low',
        subject: 'science',
      },
      {
        basisState: 'conflicted',
        gradeBand: 'middle_primary',
        imageQuality: 'degraded',
        questionType: 'science_observation',
        riskLevel: 'medium',
        subject: 'science',
      },
    ];
    const policyResponse = await app.inject({
      headers: headers('metrics-operator'),
      method: 'POST',
      payload: {
        commandId: 'register-policy-1',
        policy: {
          minimumSampleSize: 20,
          requiredSignoffRoles: ['quality_owner', 'domain_reviewer', 'child_safety'],
          requiredSlices: slices,
          version: 'quality-policy-v1',
        },
        reason: '登记首发质量切片策略',
      },
      url: '/internal/operations/quality-control/policies',
    });
    expect(policyResponse.statusCode).toBe(201);
    const capabilityResponse = await app.inject({
      headers: headers('metrics-operator'),
      method: 'POST',
      payload: {
        commandId: 'register-capability-1',
        reason: '登记 OCR 实现版本',
        version: {
          adapter: { id: 'ocr-adapter', version: '1' },
          artifactHash: 'a'.repeat(64),
          capabilityKey: 'submission-ocr',
          id: 'ocr-v1',
          kind: 'ocr',
          modelOrEngine: { id: 'ocr-engine', version: '1' },
          policyVersion: 'provider-policy-v1',
          promptOrConfig: { kind: 'config', version: '1' },
          provider: { id: 'shanghai-ocr', version: '1' },
          region: 'cn-shanghai',
          requiredSlicePolicyVersion: 'quality-policy-v1',
          templateVersion: '1',
        },
      },
      url: '/internal/operations/quality-control/capabilities',
    });
    expect(capabilityResponse.statusCode).toBe(201);
    for (const [index, slice] of slices.entries()) {
      const evaluationResponse = await app.inject({
        headers: headers('metrics-operator'),
        method: 'POST',
        payload: {
          commandId: `record-evaluation-${index + 1}`,
          expectedRevision: index,
          reason: '录入独立测试证据',
          run: {
            completedAt: `2026-09-13T08:0${index}:00.000Z`,
            evidenceHash: String(index + 1).repeat(64),
            id: `ocr-evaluation-${index + 1}`,
            metrics: { accuracy: 1 },
            outcome: 'passed',
            policyVersion: 'quality-policy-v1',
            sampleSize: 20,
            slice,
          },
        },
        url: '/internal/operations/quality-control/capabilities/ocr-v1/evaluations',
      });
      expect(evaluationResponse.statusCode).toBe(201);
    }
    const cardResponse = await app.inject({
      headers: headers('quality-owner'),
      method: 'GET',
      url: '/internal/operations/quality-control/capabilities/ocr-v1/card',
    });
    expect(cardResponse.statusCode).toBe(200);
    const card = cardResponse.json().data;
    expect(card).toMatchObject({ capabilityVersionId: 'ocr-v1', status: 'passed' });
    for (const [index, principal] of [
      'quality-owner',
      'domain-reviewer',
      'child-safety',
    ].entries()) {
      const signoff = await app.inject({
        headers: headers(principal as 'quality-owner' | 'domain-reviewer' | 'child-safety'),
        method: 'PUT',
        payload: {
          commandId: `signoff-${index + 1}`,
          evidenceHash: card.evidenceHash,
          expectedRevision: index + 5,
          policyVersion: card.policyVersion,
          reason: '按职责独立签署当前质量卡',
        },
        url: '/internal/operations/quality-control/capabilities/ocr-v1/signoffs',
      });
      expect(signoff.statusCode).toBe(200);
    }
    const rollout = await app.inject({
      headers: headers('release-manager'),
      method: 'POST',
      payload: {
        allowedUseSlices: [slices[0]],
        commandId: 'rollout-shadow-1',
        expectedRevision: 8,
        percentage: 0,
        reason: '签署完毕后进入影子验证',
        stage: 'shadow',
      },
      url: '/internal/operations/quality-control/capabilities/ocr-v1/rollout',
    });
    expect(rollout.statusCode).toBe(201);
    expect(rollout.json().data).toMatchObject({ rollout: { stage: 'shadow' } });

    const quality = await app.inject({
      headers: headers('release-manager'),
      method: 'POST',
      payload: { reason: '读取 T09 当前发布与签署状态' },
      url: '/internal/operations/provider-quality-readiness/evaluate',
    });
    expect(quality.statusCode).toBe(201);
    expect(quality.json().data).toMatchObject({ passed: true, reasons: [] });
    const savedQuality = await app.inject({
      headers: headers('release-manager'),
      method: 'GET',
      url: '/internal/operations/provider-quality-readiness',
    });
    expect(savedQuality.json().data).toMatchObject({ passed: true });

    const readinessEvidence = await app.inject({
      headers: headers('release-manager'),
      method: 'PUT',
      payload: {
        passed: true,
        reason: '签署核心闭环开发证据',
        reference: 'ci://run/123',
      },
      url: '/internal/operations/readiness-evidence/core_learning_flow',
    });
    expect(readinessEvidence.statusCode).toBe(200);
    const forgedProviderQuality = await app.inject({
      headers: headers('release-manager'),
      method: 'PUT',
      payload: {
        passed: true,
        reason: '尝试绕过质量控制权威',
        reference: 'self://approved',
      },
      url: '/internal/operations/readiness-evidence/provider_quality',
    });
    expect(forgedProviderQuality.statusCode).toBe(500);
    const readiness = await app.inject({
      headers: headers('release-manager'),
      method: 'GET',
      url: '/internal/operations/readiness',
    });
    expect(readiness.json().data).toMatchObject({
      developmentComplete: { achieved: true },
      familyPilotReady: { achieved: false },
      publicReleaseAllowed: false,
    });
    const deniedContainment = await app.inject({
      headers: headers('metrics-operator'),
      method: 'POST',
      payload: {
        commandId: 'contain-ocr-v1',
        containedAt: '2026-09-13T09:00:00.000Z',
        expectedContainmentEpoch: 0,
        reason: '检测到关键错误，立即停止使用',
      },
      url: '/internal/operations/quality-control/capabilities/ocr-v1/containment',
    });
    expect(deniedContainment.statusCode).toBe(401);
    const containmentRequest = {
      headers: headers('release-manager'),
      method: 'POST' as const,
      payload: {
        commandId: 'contain-ocr-v1',
        containedAt: '2026-09-13T09:00:00.000Z',
        expectedContainmentEpoch: 0,
        reason: '检测到关键错误，立即停止使用',
      },
      url: '/internal/operations/quality-control/capabilities/ocr-v1/containment',
    };
    const containment = await app.inject(containmentRequest);
    expect(containment.statusCode).toBe(201);
    expect(containment.json().data).toMatchObject({
      epoch: 1,
      orders: [{ target: { id: 'ocr-v1', kind: 'capability_version' } }],
    });
    const containmentReplay = await app.inject(containmentRequest);
    expect(containmentReplay.statusCode).toBe(201);
    expect(containmentReplay.json().data.orders).toHaveLength(1);
    expect(metricsStore.audits.map(({ action }) => action)).toEqual([
      'provider_quality.evaluate',
      'readiness.record',
    ]);
  });
});
