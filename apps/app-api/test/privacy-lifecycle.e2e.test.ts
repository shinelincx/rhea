import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import {
  MemoryPrivacyDataPort,
  MemoryPrivacyLifecycleStore,
  PrivacyLifecycleService,
} from '@rhea/privacy-lifecycle';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('privacy lifecycle HTTP interface', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => app?.close());

  it('requires guardian reverification for export and exact-confirmation erasure', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const login = await familyAccess.loginGuardian({ identityAssertion: 'privacy-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: login.accessToken,
      name: '隐私测试家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: login.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 4,
      pin: '2468',
    });
    const otherFamily = await familyAccess.createFamilySpace({
      accessToken: login.accessToken,
      name: '另一个家庭空间',
    });
    const otherProfile = await familyAccess.createLearningProfile({
      accessToken: login.accessToken,
      displayName: '小岚',
      familySpaceId: otherFamily.id,
      grade: 4,
      pin: '1357',
    });
    const store = new MemoryPrivacyLifecycleStore();
    const data = new (class extends MemoryPrivacyDataPort {
      override async profileExists(input: { familySpaceId: string; learningProfileId: string }) {
        return (
          (input.familySpaceId === family.id && input.learningProfileId === profile.id) ||
          (input.familySpaceId === otherFamily.id && input.learningProfileId === otherProfile.id)
        );
      }
    })();
    const privacy = new PrivacyLifecycleService(
      store,
      data,
      'privacy-api-test-tombstone-pepper-32-bytes',
      { now: new Date('2026-09-13T08:00:00.000Z') },
    );
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      privacyLifecycleService: privacy,
    });
    await app.init();
    const prefix = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}`;

    const denied = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'GET',
      url: `${prefix}/erasure-preview`,
    });
    expect(denied.statusCode).toBe(401);
    await familyAccess.reverifyGuardian({
      accessToken: login.accessToken,
      identityAssertion: 'privacy-guardian',
    });

    const previewResponse = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'GET',
      url: `${prefix}/erasure-preview`,
    });
    const preview = previewResponse.json<{ data: { confirmationText: string } }>().data;
    expect(previewResponse.statusCode).toBe(200);

    const exportResponse = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'POST',
      url: `${prefix}/exports`,
    });
    expect(exportResponse.statusCode).toBe(201);
    const exportTask = exportResponse.json<{ data: { id: string } }>().data;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await privacy.getTask(exportTask.id)).toMatchObject({ status: 'completed' });
    const download = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'GET',
      url: `${prefix}/exports/${exportTask.id}/download`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({
      data: {
        fileName: `rhea-profile-${profile.id}.json`,
        payload: { familySpaceId: family.id, learningProfileId: profile.id },
      },
    });

    const crossFamily = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'POST',
      url: `/v1/family-spaces/${family.id}/learning-profiles/${otherProfile.id}/exports`,
    });
    expect(crossFamily.statusCode).toBe(404);

    const invalid = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'POST',
      payload: { confirmationText: '删除' },
      url: `${prefix}/erasure`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(data.frozen).toHaveLength(0);

    const erasure = await app.inject({
      headers: { authorization: `Bearer ${login.accessToken}` },
      method: 'POST',
      payload: { confirmationText: preview.confirmationText },
      url: `${prefix}/erasure`,
    });
    expect(erasure.statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const erasureTask = erasure.json<{ data: { id: string } }>().data;
    expect(await privacy.getTask(erasureTask.id)).toMatchObject({ status: 'completed' });
    expect(store.tombstones).toHaveLength(1);
  });
});
