import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('FamilyAccess HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('requires guardian reverification for separate, auditable consent decisions', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    app = await createApp({ dependencyProbes: [], familyAccess });
    await app.init();
    const login = await app.inject({
      method: 'POST',
      payload: { identityAssertion: 'consent-guardian' },
      url: '/v1/guardian-sessions',
    });
    const guardian = login.json<{ data: { accessToken: string } }>().data;
    const familyResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: { name: '授权测试家庭' },
      url: '/v1/family-spaces',
    });
    const family = familyResponse.json<{ data: { id: string } }>().data;

    const beforeReverification = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'PUT',
      payload: { granted: true },
      url: `/v1/family-spaces/${family.id}/consents/photo_processing`,
    });
    expect(beforeReverification.statusCode).toBe(401);
    expect(beforeReverification.json()).toMatchObject({
      error: {
        code: 'GUARDIAN_REVERIFICATION_REQUIRED',
        recovery: 'REVERIFY_GUARDIAN',
      },
    });

    const reverification = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: { identityAssertion: 'consent-guardian' },
      url: '/v1/guardian-reverification',
    });
    expect(reverification.statusCode).toBe(201);
    expect(reverification.json()).toMatchObject({
      data: { reverifiedAt: expect.any(String), validUntil: expect.any(String) },
    });

    const granted = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'PUT',
      payload: { granted: true },
      url: `/v1/family-spaces/${family.id}/consents/photo_processing`,
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({
      data: {
        dataScope: [expect.any(String)],
        purpose: expect.any(String),
        revision: 1,
        statementVersion: 'family-consent-v1',
        status: 'granted',
        updatedAt: expect.any(String),
      },
    });

    const withdrawn = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'PUT',
      payload: { granted: false },
      url: `/v1/family-spaces/${family.id}/consents/photo_processing`,
    });
    expect(withdrawn.json()).toMatchObject({ data: { revision: 2, status: 'withdrawn' } });
    const history = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'GET',
      url: `/v1/family-spaces/${family.id}/consents/photo_processing/history`,
    });
    expect(history.json()).toMatchObject({
      data: [
        { revision: 1, status: 'granted' },
        { previousStatus: 'granted', revision: 2, status: 'withdrawn' },
      ],
    });
  });

  it('completes guardian setup and a restricted shared-device learner entry', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    app = await createApp({ dependencyProbes: [], familyAccess });
    await app.init();

    const login = await app.inject({
      method: 'POST',
      payload: { identityAssertion: 'verified-guardian' },
      url: '/v1/guardian-sessions',
    });
    expect(login.statusCode).toBe(201);
    const guardian = login.json<{ data: { accessToken: string } }>().data;

    const familyResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: { name: '小禾的家庭' },
      url: '/v1/family-spaces',
    });
    const family = familyResponse.json<{ data: { id: string } }>().data;
    expect(familyResponse.statusCode).toBe(201);

    const profileResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: { displayName: '小禾', grade: 3, pin: '2468' },
      url: `/v1/family-spaces/${family.id}/learning-profiles`,
    });
    const profile = profileResponse.json<{ data: { id: string } }>().data;
    expect(profileResponse.statusCode).toBe(201);

    const deviceResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: { label: '客厅平板' },
      url: `/v1/family-spaces/${family.id}/devices`,
    });
    const device = deviceResponse.json<{ data: { accessToken: string } }>().data;
    expect(deviceResponse.statusCode).toBe(201);

    const profiles = await app.inject({
      headers: { authorization: `Device ${device.accessToken}` },
      method: 'GET',
      url: '/v1/device-learning-profiles',
    });
    expect(profiles.json()).toMatchObject({ data: [{ displayName: '小禾', grade: 3 }] });

    const learnerResponse = await app.inject({
      headers: { authorization: `Device ${device.accessToken}` },
      method: 'POST',
      payload: { learningProfileId: profile.id, pin: '2468' },
      url: '/v1/learner-sessions',
    });
    const learner = learnerResponse.json<{ data: { accessToken: string } }>().data;
    expect(learnerResponse.statusCode).toBe(201);

    const learnerSession = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: '/v1/session',
    });
    expect(learnerSession.json()).toMatchObject({
      data: { actor: { learningProfileId: profile.id, type: 'learner' } },
    });

    const forbidden = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: { name: '越权家庭' },
      url: '/v1/family-spaces',
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      error: { code: 'CAPABILITY_DENIED', recovery: 'ENTER_GUARDIAN_MODE' },
    });

    const logout = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'DELETE',
      url: '/v1/session',
    });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: '/v1/session',
    });
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json()).toMatchObject({
      error: { code: 'SESSION_INVALID', recovery: 'REENTER_SESSION' },
    });
  });

  it('returns bounded, recoverable feedback for repeated invalid PIN entries', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'pin-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: 'PIN 家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 3,
      pin: '2468',
    });
    const device = await familyAccess.registerDevice({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      label: '共享设备',
    });
    app = await createApp({ dependencyProbes: [], familyAccess });
    await app.init();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await app.inject({
        headers: { authorization: `Device ${device.accessToken}` },
        method: 'POST',
        payload: { learningProfileId: profile.id, pin: '0000' },
        url: '/v1/learner-sessions',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'PIN_INVALID', remainingAttempts: 5 - attempt },
      });
    }
    const locked = await app.inject({
      headers: { authorization: `Device ${device.accessToken}` },
      method: 'POST',
      payload: { learningProfileId: profile.id, pin: '0000' },
      url: '/v1/learner-sessions',
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('300');
    expect(locked.json()).toMatchObject({
      error: { code: 'PIN_LOCKED', recovery: 'WAIT_AND_RETRY', retryAfterSeconds: 300 },
    });
  });
});
