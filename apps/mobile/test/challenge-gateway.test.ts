import { createChallengeGateway, type MobileChallenge } from '../src/challenge/challenge-gateway';

const challenge: MobileChallenge = {
  authorizationDecisionId: 'decision-1',
  capabilityVersionId: 'capability-1',
  createdAt: '2026-09-12T01:00:00.000Z',
  evidenceQualification: 'assisted_only',
  id: 'challenge-1',
  items: [
    {
      difficulty: 'foundation',
      id: 'item-1',
      knowledgePoint: '加法',
      options: null,
      prompt: '1+1=?',
      response: null,
    },
  ],
  knowledgeFeedback: [],
  myProgress: { completedItems: 0, totalItems: 1 },
  noPenalty: true,
  opponentProgress: { completedItems: 0, totalItems: 1 },
  relationId: 'relation-1',
  score: null,
  speedAffectsScore: false,
  status: 'active',
  subject: 'mathematics',
  target: '加法',
};

const scope = {
  accessToken: 'token-1',
  familySpaceId: 'family-1',
  learningProfileId: 'profile-1',
};

describe('challenge gateway', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses privacy-safe challenge views and submits idempotent objective answers', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [challenge] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              ...challenge,
              items: [
                {
                  ...challenge.items[0],
                  response: {
                    answer: '2',
                    correct: true,
                    submittedAt: '2026-09-12T01:01:00.000Z',
                  },
                },
              ],
              myProgress: { completedItems: 1, totalItems: 1 },
            },
          }),
          { status: 201 },
        ),
      );
    const gateway = createChallengeGateway('https://api.example.test');

    await expect(gateway.listChallenges(scope)).resolves.toEqual([challenge]);
    await expect(
      gateway.submitAnswer({
        ...scope,
        answer: '2',
        challengeId: challenge.id,
        commandId: 'command-1',
        itemId: 'item-1',
      }),
    ).resolves.toMatchObject({ myProgress: { completedItems: 1 } });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ answer: '2', commandId: 'command-1', itemId: 'item-1' }),
      method: 'POST',
    });
  });

  it('fails closed when the server claims speed affects score', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ ...challenge, speedAffectsScore: true }] }), {
        status: 200,
      }),
    );
    await expect(
      createChallengeGateway('https://api.example.test').listChallenges(scope),
    ).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  it('shows the server recovery message for expired invites', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'INVITE_EXPIRED', message: '这个邀请码已过期' } }),
          { status: 409 },
        ),
      );
    await expect(
      createChallengeGateway('https://api.example.test').redeemInvite({
        ...scope,
        code: 'ABCDEFGH2345',
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_FAILED', message: '这个邀请码已过期' });
  });
});
