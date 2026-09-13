import { describe, expect, it } from 'vitest';

import { MemorySafetyEscalationStore, SafetyEscalationService } from '../src/index.js';

describe('SafetyEscalationService', () => {
  it('classifies every supported source and stores hashes instead of raw child content', async () => {
    const store = new MemorySafetyEscalationStore();
    const service = new SafetyEscalationService(store, {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    const unsafeContent = '我不想活了，也不想告诉监护人';

    const result = await service.classify({
      content: unsafeContent,
      familySpaceId: 'family-1',
      guardianMayBeInvolved: true,
      learningProfileId: 'profile-1',
      source: 'ai_input',
      sourceReferenceId: 'generation-1',
    });

    await service.classify({
      content: '这是一段普通的学习反馈',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      source: 'ai_output',
      sourceReferenceId: 'generation-1:output',
    });
    await service.classify({
      content: '对方要求我和他私下见面',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      source: 'challenge_event',
      sourceReferenceId: 'challenge-1:report',
    });

    expect(result).toMatchObject({
      action: 'escalate',
      category: 'self_harm',
      guardianNotification: 'suppressed_guardian_may_be_involved',
      severity: 'critical',
    });
    expect(result.guidance).toContain('AI 不能提供实时救援');
    expect(JSON.stringify(store.classifications)).not.toContain(unsafeContent);
    expect(store.classifications).toHaveLength(3);
    expect(store.cases).toHaveLength(2);
  });

  it('uses scoped, expiring and revocable support grants and audits every decision', async () => {
    const clock = { now: new Date('2026-09-13T08:00:00.000Z') };
    const store = new MemorySafetyEscalationStore();
    const service = new SafetyEscalationService(store, clock);
    const grant = await service.grantSupportAccess({
      allowedRecordIds: ['job-1'],
      createdByGuardianId: 'guardian-1',
      durationMinutes: 5,
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      reason: '协助排查一次识别失败',
      scopes: ['processing_status', 'specified_record'],
      supportPrincipalId: 'support-1',
    });

    await expect(
      service.authorizeSupportOperation({
        action: 'view_record',
        familySpaceId: 'family-1',
        grantId: grant.id,
        recordId: 'job-1',
        scope: 'specified_record',
        supportPrincipalId: 'support-1',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'allowed' });
    await expect(
      service.authorizeSupportOperation({
        action: 'view_record',
        familySpaceId: 'family-1',
        grantId: grant.id,
        recordId: 'job-2',
        scope: 'specified_record',
        supportPrincipalId: 'support-1',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'record_not_allowed' });

    clock.now = new Date('2026-09-13T08:05:00.000Z');
    await expect(
      service.authorizeSupportOperation({
        action: 'view_status',
        familySpaceId: 'family-1',
        grantId: grant.id,
        scope: 'processing_status',
        supportPrincipalId: 'support-1',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'expired' });
    expect(store.supportAudit).toHaveLength(3);

    clock.now = new Date('2026-09-13T08:01:00.000Z');
    await service.revokeSupportAccess({
      familySpaceId: 'family-1',
      grantId: grant.id,
      guardianId: 'guardian-1',
    });
    await expect(
      service.authorizeSupportOperation({
        action: 'view_status',
        familySpaceId: 'family-1',
        grantId: grant.id,
        scope: 'processing_status',
        supportPrincipalId: 'support-1',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'revoked' });
    expect(store.supportAudit).toHaveLength(4);
  });

  it('keeps escalation failures and false positives recoverable', async () => {
    const store = new MemorySafetyEscalationStore();
    const service = new SafetyEscalationService(store);
    const result = await service.classify({
      content: '有人威胁我去私下见面',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      source: 'challenge_event',
      sourceReferenceId: 'report-1',
    });

    await expect(
      service.listActionableCases({
        operatorId: 'child-safety-operator',
        reason: '读取待处置安全个案',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: result.caseId,
        notificationStatus: 'pending',
        severity: 'high',
      }),
    ]);
    expect(store.caseQueueAccesses).toEqual([
      expect.objectContaining({ caseIds: [result.caseId], operatorId: 'child-safety-operator' }),
    ]);
    await service.operateCase({
      action: 'claim',
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000001',
      operatorId: 'child-safety-operator',
      reason: '领取待处置安全个案',
    });
    await service.operateCase({
      action: 'claim',
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000001',
      operatorId: 'child-safety-operator',
      reason: '领取待处置安全个案',
    });

    await service.markEscalationFailure({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000002',
      operatorId: 'child-safety-operator',
      reason: '人工升级通道暂时不可用',
    });
    expect(store.cases.get(result.caseId!)?.status).toBe('pending_retry');
    await service.retryEscalation({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000003',
      operatorId: 'child-safety-operator',
      reason: '人工升级通道已恢复',
    });
    expect(store.cases.get(result.caseId!)?.status).toBe('open');
    await service.resolveCase({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000004',
      falsePositive: true,
      operatorId: 'child-safety-operator',
      reason: '人工复核为语境误报',
    });
    await service.resolveCase({
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000004',
      falsePositive: true,
      operatorId: 'child-safety-operator',
      reason: '人工复核为语境误报',
    });
    expect(store.cases.get(result.caseId!)?.status).toBe('closed_false_positive');
    expect(store.caseOperations).toEqual([
      expect.objectContaining({ action: 'claim', applied: true }),
      expect.objectContaining({ action: 'escalation_failed', applied: true }),
      expect.objectContaining({ action: 'retry_started', applied: true }),
      expect.objectContaining({ action: 'false_positive', applied: true }),
    ]);
  });

  it('returns expired claims to the shared queue and allows another operator to take over', async () => {
    const store = new MemorySafetyEscalationStore();
    const first = new SafetyEscalationService(store, {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    const result = await first.classify({
      content: '有人威胁我私下见面',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      source: 'challenge_event',
      sourceReferenceId: 'report-lease',
    });
    await first.operateCase({
      action: 'claim',
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000031',
      operatorId: 'operator-a',
      reason: '领取个案',
    });
    const afterExpiry = new SafetyEscalationService(store, {
      now: new Date('2026-09-13T08:11:00.000Z'),
    });
    await expect(
      afterExpiry.listActionableCases({ operatorId: 'operator-b', reason: '接管超时个案' }),
    ).resolves.toEqual([expect.objectContaining({ id: result.caseId })]);
    await afterExpiry.operateCase({
      action: 'claim',
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000032',
      operatorId: 'operator-b',
      reason: '接管超时个案',
    });
    expect(store.cases.get(result.caseId!)).toMatchObject({
      assignedOperatorId: 'operator-b',
      claimExpiresAt: '2026-09-13T08:21:00.000Z',
    });
    await afterExpiry.operateCase({
      action: 'release',
      caseId: result.caseId!,
      commandId: '00000000-0000-4000-8000-000000000033',
      operatorId: 'operator-b',
      reason: '交回共享队列',
    });
    expect(store.cases.get(result.caseId!)).toMatchObject({
      assignedOperatorId: null,
      claimExpiresAt: null,
    });
  });

  it('adapts calm safety guidance to the learner age band without storing raw content', async () => {
    const store = new MemorySafetyEscalationStore();
    const service = new SafetyEscalationService(store);
    const lower = await service.classify({
      ageBand: 'lower_primary',
      content: '有人让我私下见面',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-lower',
      source: 'ai_input',
      sourceReferenceId: 'lower-input',
    });
    const upper = await service.classify({
      ageBand: 'upper_primary',
      content: '有人让我私下见面',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-upper',
      source: 'ai_input',
      sourceReferenceId: 'upper-input',
    });

    expect(lower.guidance).toContain('马上去找');
    expect(upper.guidance).toContain('离开让你不舒服或有危险的情境');
    expect(lower.guidance).not.toBe(upper.guidance);
    expect(store.classifications.map(({ ageBand }) => ageBand)).toEqual([
      'lower_primary',
      'upper_primary',
    ]);
    expect(JSON.stringify(store.classifications)).not.toContain('有人让我私下见面');
  });
});
