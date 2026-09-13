import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { MemorySafetyEscalationStore, SafetyEscalationService } from '@rhea/safety-escalation';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('guardian support access HTTP interface', () => {
  let app: NestFastifyApplication | undefined;
  const originalSupportToken = process.env.SUPPORT_SERVICE_TOKEN;
  afterEach(async () => {
    if (originalSupportToken === undefined) delete process.env.SUPPORT_SERVICE_TOKEN;
    else process.env.SUPPORT_SERVICE_TOKEN = originalSupportToken;
    await app?.close();
  });

  it('requires reverification and creates a scoped, expiring, revocable grant', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const login = await familyAccess.loginGuardian({ identityAssertion: 'support-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: login.accessToken,
      name: '支持测试家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: login.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 4,
      pin: '2468',
    });
    const store = new MemorySafetyEscalationStore();
    const safety = new SafetyEscalationService(store, {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      safetyEscalationService: safety,
      supportDataReader: {
        async authorizeAndRead(input) {
          const decision = await safety.authorizeSupportOperation(input);
          return {
            allowed: decision.allowed,
            expiresAt: decision.grant?.expiresAt ?? null,
            familySpaceId: decision.grant?.familySpaceId ?? null,
            learningProfileId: decision.grant?.learningProfileId ?? null,
            reason: decision.reason,
            record: decision.allowed
              ? { errorCode: 'OCR_FAILED', id: input.recordId, status: 'failed' }
              : null,
          };
        },
      },
    });
    await app.init();
    const url = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}/support-access-grants`;

    const denied = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'POST',
      payload: {
        allowedRecordIds: ['job-1'],
        durationMinutes: 30,
        reason: '协助排查一次识别失败',
        scopes: ['specified_record'],
        supportPrincipalId: 'support-1',
      },
      url,
    });
    expect(denied.statusCode).toBe(401);

    await familyAccess.reverifyGuardian({
      accessToken: login.accessToken,
      identityAssertion: 'support-guardian',
    });
    const created = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'POST',
      payload: {
        allowedRecordIds: ['job-1'],
        durationMinutes: 30,
        reason: '协助排查一次识别失败',
        scopes: ['specified_record'],
        supportPrincipalId: 'support-1',
      },
      url,
    });
    expect(created.statusCode).toBe(201);
    const grant = created.json<{ data: { id: string } }>().data;
    expect(store.grants.get(grant.id)).toMatchObject({
      allowedRecordIds: ['job-1'],
      scopes: ['specified_record'],
      supportPrincipalId: 'support-1',
    });

    process.env.SUPPORT_SERVICE_TOKEN = 'support-service-test-token';
    const operation = await app.inject({
      headers: {
        'x-rhea-support-principal': 'support-1',
        'x-rhea-support-token': 'support-service-test-token',
      },
      method: 'POST',
      payload: {
        action: 'inspect failed OCR metadata',
        recordId: 'job-1',
        scope: 'specified_record',
      },
      url: `/v1/family-spaces/${family.id}/support-access-grants/${grant.id}/operations`,
    });
    expect(operation.statusCode).toBe(201);
    expect(operation.json().data.record).toEqual({
      errorCode: 'OCR_FAILED',
      id: 'job-1',
      status: 'failed',
    });
    expect(store.supportAudit).toContainEqual(
      expect.objectContaining({ allowed: true, grantId: grant.id, recordId: 'job-1' }),
    );

    const wrongFamily = await app.inject({
      headers: {
        'x-rhea-support-principal': 'support-1',
        'x-rhea-support-token': 'support-service-test-token',
      },
      method: 'POST',
      payload: {
        action: 'inspect failed OCR metadata',
        recordId: 'job-1',
        scope: 'specified_record',
      },
      url: `/v1/family-spaces/${randomUUID()}/support-access-grants/${grant.id}/operations`,
    });
    expect(wrongFamily.statusCode).toBe(403);
    expect(store.supportAudit).toContainEqual(
      expect.objectContaining({ allowed: false, grantId: grant.id, recordId: 'job-1' }),
    );

    const revoked = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'DELETE',
      url: `/v1/family-spaces/${family.id}/support-access-grants/${grant.id}`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(store.grants.get(grant.id)?.revokedAt).toEqual(expect.any(String));
  });
});
