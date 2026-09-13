import { describe, expect, it } from 'vitest';

import {
  ChallengeError,
  ChallengeService,
  MemoryChallengeAuthorization,
  MemoryChallengeMatchPool,
  MemoryChallengeStore,
  type ChallengeActor,
  type ChallengePackFactory,
} from '../src/index.js';

const alice: ChallengeActor = {
  familySpaceId: 'family-a',
  learningProfileId: 'alice',
};
const bob: ChallengeActor = {
  familySpaceId: 'family-b',
  learningProfileId: 'bob',
};

function packs(): ChallengePackFactory {
  return {
    async createEquivalentPacks(input) {
      return {
        authorizationDecisionId: 'decision-1',
        capabilityVersionId: 'challenge-pack-v1',
        packs: input.participants.map((participant, participantIndex) => ({
          items: [
            {
              difficulty: 'foundation' as const,
              gradingRule: { expected: String(2 + participantIndex), kind: 'numeric' as const },
              id: `${participant.learningProfileId}-1`,
              knowledgePoint: '20 以内加法',
              prompt: participantIndex === 0 ? '1 + 1 = ?' : '1 + 2 = ?',
            },
            {
              difficulty: 'practice' as const,
              gradingRule: { correctOptionId: 'b', kind: 'single_choice' as const },
              id: `${participant.learningProfileId}-2`,
              knowledgePoint: '比较大小',
              options: [
                { id: 'a', text: '3' },
                { id: 'b', text: '5' },
              ],
              prompt: participantIndex === 0 ? '3 和 5 哪个大？' : '4 和 5 哪个大？',
            },
          ],
          learningProfileId: participant.learningProfileId,
        })),
      };
    },
  };
}

function fixture() {
  const clock = { now: new Date('2026-09-12T01:00:00.000Z') };
  const authorization = new MemoryChallengeAuthorization([
    { ...alice, consentRevision: 1, grade: 3, status: 'granted' },
    { ...bob, consentRevision: 2, grade: 3, status: 'granted' },
  ]);
  const store = new MemoryChallengeStore();
  const service = new ChallengeService({
    authorization,
    clock,
    invitationPepper: 'test-only-pepper-with-enough-entropy',
    packFactory: packs(),
    store,
  });
  return { authorization, clock, service, store };
}

async function partner(service: ChallengeService) {
  const invite = await service.createPartnerInvite({ actor: alice });
  const relation = await service.redeemPartnerInvite({ actor: bob, code: invite.code });
  return relation;
}

describe('ChallengeService partner invitations', () => {
  it('creates a non-enumerable, one-time short-lived code and a persistent partner relation', async () => {
    const { service, store } = fixture();
    const invite = await service.createPartnerInvite({ actor: alice });

    expect(invite.code).toMatch(/^[A-Z2-9]{12}$/);
    expect(invite.expiresAt).toBe('2026-09-12T01:15:00.000Z');
    expect(JSON.stringify(store.debugState())).not.toContain(invite.code);

    const relation = await service.redeemPartnerInvite({ actor: bob, code: invite.code });
    expect(relation.participants.map((entry) => entry.learningProfileId).sort()).toEqual([
      'alice',
      'bob',
    ]);
    expect(relation.status).toBe('active');

    await expect(
      service.redeemPartnerInvite({ actor: bob, code: invite.code }),
    ).rejects.toMatchObject({ code: 'INVITE_ALREADY_USED' });
  });

  it('fails closed for invalid, expired, self-use, missing grade, and withdrawn consent', async () => {
    const { authorization, clock, service } = fixture();

    await expect(
      service.redeemPartnerInvite({ actor: bob, code: 'ZZZZZZZZZZZZ' }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    const first = await service.createPartnerInvite({ actor: alice });
    await expect(
      service.redeemPartnerInvite({ actor: alice, code: first.code }),
    ).rejects.toMatchObject({ code: 'INVITE_SELF_USE' });

    const expiring = await service.createPartnerInvite({ actor: alice });
    clock.now = new Date('2026-09-12T01:16:00.000Z');
    await expect(
      service.redeemPartnerInvite({ actor: bob, code: expiring.code }),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED' });

    authorization.set({ ...bob, consentRevision: 3, grade: null, status: 'granted' });
    await expect(service.createPartnerInvite({ actor: bob })).rejects.toMatchObject({
      code: 'GRADE_REQUIRED',
    });
    authorization.set({ ...alice, consentRevision: 4, grade: 3, status: 'withdrawn' });
    await expect(service.createPartnerInvite({ actor: alice })).rejects.toMatchObject({
      code: 'CHALLENGE_CONSENT_REQUIRED',
    });
  });
});

describe('ChallengeService objective asynchronous challenge', () => {
  it('publishes equivalent authorized packs without exposing the opponent pack', async () => {
    const { service } = fixture();
    const relation = await partner(service);
    const challenge = await service.createChallenge({
      actor: alice,
      relationId: relation.id,
      subject: 'mathematics',
      target: '20 以内加法与比较大小',
    });

    expect(challenge.capabilityVersionId).toBe('challenge-pack-v1');
    expect(challenge.items).toHaveLength(2);
    expect(challenge.items.map((item) => item.prompt)).toEqual(['1 + 1 = ?', '3 和 5 哪个大？']);
    expect(JSON.stringify(challenge)).not.toContain('1 + 2 = ?');
    expect(challenge.score).toBeNull();

    const resumed = await service.getChallenge({ actor: alice, challengeId: challenge.id });
    expect(resumed.items).toEqual(challenge.items);
    expect(resumed.myProgress.completedItems).toBe(0);
  });

  it('grades objective answers deterministically, idempotently, and shows results only after both finish', async () => {
    const { service } = fixture();
    const relation = await partner(service);
    const created = await service.createChallenge({
      actor: alice,
      relationId: relation.id,
      subject: 'mathematics',
      target: '20 以内加法与比较大小',
    });

    const first = await service.submitAnswer({
      actor: alice,
      answer: '2',
      challengeId: created.id,
      commandId: 'alice-answer-1',
      itemId: 'alice-1',
    });
    const repeated = await service.submitAnswer({
      actor: alice,
      answer: '2',
      challengeId: created.id,
      commandId: 'alice-answer-1',
      itemId: 'alice-1',
    });
    expect(repeated).toEqual(first);
    await service.submitAnswer({
      actor: alice,
      answer: 'a',
      challengeId: created.id,
      commandId: 'alice-answer-2',
      itemId: 'alice-2',
    });
    expect(
      (await service.getChallenge({ actor: alice, challengeId: created.id })).score,
    ).toBeNull();

    await service.submitAnswer({
      actor: bob,
      answer: '3',
      challengeId: created.id,
      commandId: 'bob-answer-1',
      itemId: 'bob-1',
    });
    const completed = await service.submitAnswer({
      actor: bob,
      answer: 'b',
      challengeId: created.id,
      commandId: 'bob-answer-2',
      itemId: 'bob-2',
    });

    expect(completed.status).toBe('completed');
    const aliceResult = await service.getChallenge({ actor: alice, challengeId: created.id });
    expect(aliceResult.score).toMatchObject({ correctItems: 1, totalItems: 2 });
    expect(aliceResult.knowledgeFeedback).toEqual([
      { correctItems: 1, knowledgePoint: '20 以内加法', totalItems: 1 },
      { correctItems: 0, knowledgePoint: '比较大小', totalItems: 1 },
    ]);
    expect(aliceResult.evidenceQualification).toBe('assisted_only');
    expect(aliceResult.speedAffectsScore).toBe(false);
  });

  it('rejects non-objective or inequivalent generated packs before persistence', async () => {
    const { service: baseService, store, authorization, clock } = fixture();
    const relation = await partner(baseService);
    const invalidFactory: ChallengePackFactory = {
      async createEquivalentPacks() {
        return {
          authorizationDecisionId: 'decision-invalid',
          capabilityVersionId: 'challenge-pack-v2',
          packs: [
            {
              learningProfileId: 'alice',
              items: [
                {
                  difficulty: 'foundation',
                  gradingRule: { acceptedAnswers: ['because'], kind: 'accepted_text' },
                  id: 'open-1',
                  knowledgePoint: '说明理由',
                  prompt: '请说明理由',
                },
              ],
            },
            { learningProfileId: 'bob', items: [] },
          ],
        };
      },
    };
    const service = new ChallengeService({
      authorization,
      clock,
      invitationPepper: 'test-only-pepper-with-enough-entropy',
      packFactory: invalidFactory,
      store,
    });

    await expect(
      service.createChallenge({
        actor: alice,
        relationId: relation.id,
        subject: 'mathematics',
        target: '说明理由',
      }),
    ).rejects.toBeInstanceOf(ChallengeError);
    await expect(service.listChallenges({ actor: alice })).resolves.toEqual([]);
  });

  it('lets either participant leave without penalty and blocks new challenges after dissolution', async () => {
    const { service } = fixture();
    const relation = await partner(service);
    const challenge = await service.createChallenge({
      actor: alice,
      relationId: relation.id,
      subject: 'mathematics',
      target: '20 以内加法与比较大小',
    });

    const left = await service.leaveChallenge({ actor: bob, challengeId: challenge.id });
    expect(left).toMatchObject({ noPenalty: true, status: 'cancelled' });
    await expect(
      service.submitAnswer({
        actor: alice,
        answer: '2',
        challengeId: challenge.id,
        commandId: 'too-late',
        itemId: 'alice-1',
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_NOT_ACTIVE' });

    const dissolved = await service.dissolvePartnerRelation({
      actor: alice,
      relationId: relation.id,
    });
    expect(dissolved.status).toBe('dissolved');
    await expect(
      service.createChallenge({
        actor: bob,
        relationId: relation.id,
        subject: 'mathematics',
        target: '20 以内加法与比较大小',
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_RELATION_INACTIVE' });
  });

  it('does not persist a challenge when the partner relation is dissolved during pack creation', async () => {
    const { authorization, clock, service: baseService, store } = fixture();
    const relation = await partner(baseService);
    const factory = packs();
    const service = new ChallengeService({
      authorization,
      clock,
      invitationPepper: 'test-only-pepper-with-enough-entropy',
      packFactory: {
        async createEquivalentPacks(input) {
          await store.saveRelation({
            ...(await store.findRelation(relation.id, alice.learningProfileId))!,
            dissolvedAt: clock.now.toISOString(),
            status: 'dissolved',
          });
          return factory.createEquivalentPacks(input);
        },
      },
      store,
    });

    await expect(
      service.createChallenge({
        actor: alice,
        relationId: relation.id,
        subject: 'mathematics',
        target: '20 以内加法与比较大小',
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_RELATION_INACTIVE' });
    await expect(service.listChallenges({ actor: alice })).resolves.toEqual([]);
  });
});

describe('ChallengeService grade-only stranger matching', () => {
  function randomFixture() {
    const clock = { now: new Date('2026-09-12T01:00:00.000Z') };
    const carol: ChallengeActor = {
      familySpaceId: 'family-c',
      learningProfileId: 'carol',
    };
    const upperGrade: ChallengeActor = {
      familySpaceId: 'family-d',
      learningProfileId: 'dora',
    };
    const authorization = new MemoryChallengeAuthorization([
      { ...alice, consentRevision: 1, grade: 3, status: 'granted' },
      { ...bob, consentRevision: 1, grade: 3, status: 'granted' },
      { ...carol, consentRevision: 1, grade: 3, status: 'granted' },
      { ...upperGrade, consentRevision: 1, grade: 4, status: 'granted' },
    ]);
    const store = new MemoryChallengeStore();
    const matchPool = new MemoryChallengeMatchPool();
    let identitySequence = 0;
    const service = new ChallengeService({
      authorization,
      clock,
      identityFactory: () => ({
        avatarKey: `planet-${identitySequence}`,
        nickname: `星球搭档 ${++identitySequence}`,
      }),
      invitationPepper: 'test-only-pepper-with-enough-entropy',
      matchPool,
      packFactory: packs(),
      pairAvoidancePepper: 'test-only-avoidance-pepper-long-enough',
      store,
    });
    return { authorization, carol, clock, matchPool, service, store, upperGrade };
  }

  it('matches only by guardian grade and exposes a per-match system identity without social fields', async () => {
    const { carol, service, upperGrade } = randomFixture();

    await expect(service.enterMatchPool({ actor: upperGrade })).resolves.toMatchObject({
      grade: 4,
      status: 'waiting',
    });
    await expect(service.enterMatchPool({ actor: alice })).resolves.toMatchObject({
      grade: 3,
      status: 'waiting',
    });
    const matched = await service.enterMatchPool({ actor: carol });

    expect(matched.status).toBe('matched');
    if (matched.status !== 'matched') throw new Error('expected a match');
    expect(matched.challenge).toMatchObject({
      evidenceQualification: 'assisted_only',
      mode: 'random',
      opponentIdentity: { avatarKey: expect.any(String), nickname: expect.any(String) },
      relationId: null,
      speedAffectsScore: false,
      status: 'active',
    });
    expect(JSON.stringify(matched.challenge)).not.toContain(alice.learningProfileId);
    expect(Object.keys(matched.challenge.opponentIdentity!)).toEqual(['avatarKey', 'nickname']);
    expect('messages' in matched.challenge).toBe(false);
    await expect(service.enterMatchPool({ actor: carol })).resolves.toMatchObject({
      challenge: { id: matched.challenge.id },
      status: 'matched',
    });
  });

  it('deidentifies ended matches, permanently avoids a reported pair, and never penalizes exit', async () => {
    const { service, store } = randomFixture();
    await service.enterMatchPool({ actor: alice });
    const firstMatch = await service.enterMatchPool({ actor: bob });
    if (firstMatch.status !== 'matched') throw new Error('expected a match');
    const aliceView = await service.getChallenge({
      actor: alice,
      challengeId: firstMatch.challenge.id,
    });
    const reported = await service.reportRandomChallenge({
      actor: alice,
      challengeId: firstMatch.challenge.id,
      reason: 'uncomfortable',
    });
    expect(reported).toMatchObject({
      noPenalty: true,
      opponentIdentity: null,
      status: 'cancelled',
    });
    expect(store.debugState().challenges).toHaveLength(0);
    const aliceResult = store
      .debugState()
      .results.find((result) => result.owner.learningProfileId === alice.learningProfileId);
    expect(JSON.stringify(aliceResult)).not.toContain(bob.learningProfileId);
    expect(store.debugState().avoidanceTokens).toHaveLength(1);
    expect(JSON.stringify(reported)).not.toContain(aliceView.opponentIdentity?.nickname);

    await service.enterMatchPool({ actor: alice });
    const blockedRematch = await service.enterMatchPool({ actor: bob });
    expect(blockedRematch.status).toBe('waiting');

    const carolActor = { familySpaceId: 'family-c', learningProfileId: 'carol' };
    const matchedElsewhere = await service.enterMatchPool({ actor: carolActor });
    expect(matchedElsewhere.status).toBe('matched');
  });

  it('expires an unfinished challenge and removes the live opponent mapping', async () => {
    const { clock, service, store } = randomFixture();
    await service.enterMatchPool({ actor: alice });
    const match = await service.enterMatchPool({ actor: bob });
    if (match.status !== 'matched') throw new Error('expected a match');
    clock.now = new Date('2026-09-13T01:01:00.000Z');

    await expect(service.expireDueRandomChallenges()).resolves.toBe(1);
    await expect(
      service.getChallenge({ actor: alice, challengeId: match.challenge.id }),
    ).resolves.toMatchObject({
      noPenalty: true,
      opponentIdentity: null,
      status: 'cancelled',
    });
    expect(store.debugState().identityMappings).toHaveLength(0);
  });

  it('ends and deidentifies an active random match when authorization is withdrawn', async () => {
    const { authorization, service, store } = randomFixture();
    await service.enterMatchPool({ actor: alice });
    const match = await service.enterMatchPool({ actor: bob });
    if (match.status !== 'matched') throw new Error('expected a match');
    authorization.set({
      ...bob,
      consentRevision: 2,
      grade: 3,
      status: 'withdrawn',
    });

    await expect(
      service.submitAnswer({
        actor: alice,
        answer: '2',
        challengeId: match.challenge.id,
        commandId: 'after-withdrawal',
        itemId: 'alice-1',
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_CONSENT_REQUIRED' });
    expect(store.debugState().challenges).toHaveLength(0);
    await expect(
      service.getChallenge({ actor: alice, challengeId: match.challenge.id }),
    ).resolves.toMatchObject({
      endedReason: 'authorization_withdrawn',
      opponentIdentity: null,
      status: 'cancelled',
    });
  });
});
