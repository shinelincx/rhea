import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { GamificationService, MemoryGamificationStore } from '@rhea/learning-progress';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/create-app.js';

describe('Gamification HTTP interface', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => app?.close());
  it('returns only the authenticated learner profile growth view', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'growth-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '成长测试家庭',
    });
    const first = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 4,
      pin: '2468',
    });
    const second = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小川',
      familySpaceId: family.id,
      grade: 4,
      pin: '1357',
    });
    const device = await familyAccess.registerDevice({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      label: '家庭平板',
    });
    const learner = await familyAccess.issueLearnerSession({
      deviceAccessToken: device.accessToken,
      learningProfileId: first.id,
      pin: '2468',
    });
    const gamification = new GamificationService({ store: new MemoryGamificationStore() });
    await gamification.recordEvent({
      authorityState: 'accepted_current',
      eventKey: 'evidence-1',
      expiresAt: null,
      familySpaceId: family.id,
      kind: 'learning_evidence_independent',
      learningDate: '2026-09-13',
      learningProfileId: first.id,
      occurredAt: '2026-09-13T01:00:00.000Z',
      sourceReferenceId: 'evidence-1',
      sourceVersion: 'v1',
    });
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      gamificationService: gamification,
    });
    await app.init();
    const own = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `/v1/family-spaces/${family.id}/learning-profiles/${first.id}/growth`,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      data: { growthScore: 12, policy: { ranking: 'none', speedAffectsScore: false }, xp: 20 },
    });
    const other = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `/v1/family-spaces/${family.id}/learning-profiles/${second.id}/growth`,
    });
    expect(other.statusCode).toBe(403);
  });
});
