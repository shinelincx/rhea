import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

async function learner(
  familyAccess: ReturnType<typeof createInMemoryFamilyAccess>,
  identity: string,
  name: string,
) {
  const guardian = await familyAccess.loginGuardian({ identityAssertion: identity });
  const family = await familyAccess.createFamilySpace({
    accessToken: guardian.accessToken,
    name: `${name}家庭`,
  });
  const profile = await familyAccess.createLearningProfile({
    accessToken: guardian.accessToken,
    displayName: name,
    familySpaceId: family.id,
    grade: 3,
    pin: '2468',
  });
  const device = await familyAccess.registerDevice({
    accessToken: guardian.accessToken,
    familySpaceId: family.id,
    label: `${name}的平板`,
  });
  await familyAccess.reverifyGuardian({
    accessToken: guardian.accessToken,
    identityAssertion: identity,
  });
  await familyAccess.changeConsent({
    accessToken: guardian.accessToken,
    familySpaceId: family.id,
    granted: true,
    kind: 'peer_challenge',
  });
  const session = await familyAccess.issueLearnerSession({
    deviceAccessToken: device.accessToken,
    learningProfileId: profile.id,
    pin: '2468',
  });
  return { family, profile, session };
}

describe('Challenge HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => app?.close());

  it('runs invite, partner, private-pack, asynchronous answer, and no-penalty leave flows', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const alice = await learner(familyAccess, 'guardian-alice', '小禾');
    const bob = await learner(familyAccess, 'guardian-bob', '小舟');
    app = await createApp({ dependencyProbes: [], familyAccess });
    await app.init();
    const aliceBase = `/v1/family-spaces/${alice.family.id}/learning-profiles/${alice.profile.id}`;
    const bobBase = `/v1/family-spaces/${bob.family.id}/learning-profiles/${bob.profile.id}`;
    const aliceHeaders = { authorization: `Bearer ${alice.session.accessToken}` };
    const bobHeaders = { authorization: `Bearer ${bob.session.accessToken}` };

    const inviteResponse = await app.inject({
      headers: aliceHeaders,
      method: 'POST',
      url: `${aliceBase}/partner-invites`,
    });
    expect(inviteResponse.statusCode).toBe(201);
    const code = inviteResponse.json().data.code as string;

    const redeemed = await app.inject({
      headers: bobHeaders,
      method: 'POST',
      payload: { code },
      url: `${bobBase}/partner-invites/redeem`,
    });
    expect(redeemed.statusCode).toBe(201);
    const relationId = redeemed.json().data.id as string;

    const created = await app.inject({
      headers: aliceHeaders,
      method: 'POST',
      payload: { relationId, subject: 'mathematics', target: '三年级加法' },
      url: `${aliceBase}/challenges`,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: {
        capabilityVersionId: 'local-rules-challenge-pack-v1',
        evidenceQualification: 'assisted_only',
        items: [{ response: null }, { response: null }],
        speedAffectsScore: false,
      },
    });
    const challengeId = created.json().data.id as string;

    const bobChallenge = await app.inject({
      headers: bobHeaders,
      method: 'GET',
      url: `${bobBase}/challenges/${challengeId}`,
    });
    expect(bobChallenge.statusCode).toBe(200);
    expect(bobChallenge.json().data.items[0].prompt).not.toBe(created.json().data.items[0].prompt);

    const left = await app.inject({
      headers: bobHeaders,
      method: 'POST',
      url: `${bobBase}/challenges/${challengeId}/leave`,
    });
    expect(left.json()).toMatchObject({ data: { noPenalty: true, status: 'cancelled' } });
  });

  it('does not let a learner act through another profile URL', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const alice = await learner(familyAccess, 'guardian-alice-scope', '小禾');
    const bob = await learner(familyAccess, 'guardian-bob-scope', '小舟');
    app = await createApp({ dependencyProbes: [], familyAccess });
    await app.init();

    const response = await app.inject({
      headers: { authorization: `Bearer ${alice.session.accessToken}` },
      method: 'POST',
      url: `/v1/family-spaces/${bob.family.id}/learning-profiles/${bob.profile.id}/partner-invites`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CAPABILITY_DENIED' } });
  });

  it('matches strangers by grade with an ephemeral identity and ends immediately on report', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const alice = await learner(familyAccess, 'guardian-random-alice', '小禾');
    const bob = await learner(familyAccess, 'guardian-random-bob', '小舟');
    app = await createApp({ dependencyProbes: [], familyAccess });
    await app.init();
    const aliceBase = `/v1/family-spaces/${alice.family.id}/learning-profiles/${alice.profile.id}`;
    const bobBase = `/v1/family-spaces/${bob.family.id}/learning-profiles/${bob.profile.id}`;
    const aliceHeaders = { authorization: `Bearer ${alice.session.accessToken}` };
    const bobHeaders = { authorization: `Bearer ${bob.session.accessToken}` };

    const waiting = await app.inject({
      headers: aliceHeaders,
      method: 'POST',
      payload: { subject: 'mathematics', target: '联系我：不应进入题面' },
      url: `${aliceBase}/random-match-entries`,
    });
    expect(waiting.json()).toMatchObject({ data: { grade: 3, status: 'waiting' } });

    const matched = await app.inject({
      headers: bobHeaders,
      method: 'POST',
      payload: { subject: 'mathematics', target: '另一个不应显示的自由文本' },
      url: `${bobBase}/random-match-entries`,
    });
    expect(matched.statusCode).toBe(201);
    expect(matched.json()).toMatchObject({
      data: {
        challenge: {
          mode: 'random',
          opponentIdentity: { avatarKey: expect.any(String), nickname: expect.any(String) },
          relationId: null,
          target: '同年级数学基础挑战',
        },
        grade: 3,
        status: 'matched',
      },
    });
    const publicChallenge = matched.json().data.challenge as Record<string, unknown>;
    expect(Object.keys(publicChallenge.opponentIdentity as object).sort()).toEqual([
      'avatarKey',
      'nickname',
    ]);
    expect(JSON.stringify(publicChallenge)).not.toContain(alice.profile.id);
    expect(JSON.stringify(publicChallenge)).not.toContain('联系我');

    const challengeId = publicChallenge.id as string;
    const reported = await app.inject({
      headers: aliceHeaders,
      method: 'POST',
      payload: { reason: 'uncomfortable' },
      url: `${aliceBase}/challenges/${challengeId}/report`,
    });
    expect(reported.json()).toMatchObject({
      data: {
        endedReason: 'reported',
        noPenalty: true,
        opponentIdentity: null,
        status: 'cancelled',
      },
    });

    await app.inject({
      headers: aliceHeaders,
      method: 'POST',
      url: `${aliceBase}/random-match-entries`,
    });
    const blockedRematch = await app.inject({
      headers: bobHeaders,
      method: 'POST',
      url: `${bobBase}/random-match-entries`,
    });
    expect(blockedRematch.statusCode, blockedRematch.body).toBe(201);
    expect(blockedRematch.json()).toMatchObject({ data: { status: 'waiting' } });
  });
});
