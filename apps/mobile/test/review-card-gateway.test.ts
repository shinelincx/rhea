import {
  createReviewCardGateway,
  type MobileReviewCard,
} from '../src/review-cards/review-card-gateway';

const card: MobileReviewCard = {
  aiGenerated: true,
  content: {
    aiContentState: 'checked',
    keyChanges: ['更换了数字'],
    knowledgePointName: '两位数加法',
    methodHint: '按数位相加。',
    orientationHint: '先看个位。',
    question: '30 + 12 = ?',
    subject: 'mathematics',
    themeId: 'theme-1',
  },
  id: 'card-1',
  original: {
    collapsedByDefault: true,
    currentLearningBasis: {
      sourceVersionId: 'basis-1',
      validityEpoch: 1,
      versionLabel: '答案 v1',
    },
    question: '40 + 2 = ?',
    relation: 'generated_from_wrong_item',
    response: '41',
    wrongItemId: 'wrong-1',
  },
  schedule: {
    dueAt: '2026-09-12T00:00:00.000Z',
    intervalDays: 1,
    pendingCorrection: true,
    stepIndex: 0,
  },
  sourceVersion: {
    assessmentVersionId: 'assessment-1',
    capabilityVersionId: 'capability-1',
    classificationRevision: 1,
    wrongItemStateRevision: 1,
  },
};

describe('review-card gateway', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses at most five traceable cards and submits evidence inputs', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              cardIds: ['card-1'],
              cards: [card],
              createdAt: '2026-09-12T00:00:00.000Z',
              id: 'session-1',
              learningProfileId: 'profile-1',
            },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              attempt: {
                cardId: 'card-1',
                createdAt: '2026-09-12T00:01:00.000Z',
                hintLevel: 1,
                id: 'attempt-1',
                idempotencyKey: 'attempt-idem-1',
                outcome: 'correct',
                perceivedDifficulty: 'hard',
                responseText: '42',
                sessionId: 'session-1',
              },
              feedback: {
                answer: '42',
                currentState: 'scheduled',
                evidenceQualification: 'assisted',
                explanationSteps: ['30 + 12 = 42。'],
                hintImpact: '记录为辅助复习证据。',
                nextAction: '三天后再复习。',
                nextDueAt: '2026-09-15T00:01:00.000Z',
                nextIntervalDays: 3,
                outcome: 'correct',
              },
            },
          }),
          { status: 201 },
        ),
      );
    const gateway = createReviewCardGateway('https://api.example.test');
    const scope = {
      accessToken: 'token-1',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
    };
    await expect(gateway.createSession(scope)).resolves.toMatchObject({
      cards: [{ id: 'card-1' }],
    });
    await expect(
      gateway.submitAttempt({
        ...scope,
        cardId: 'card-1',
        hintLevel: 1,
        idempotencyKey: 'attempt-idem-1',
        perceivedDifficulty: 'hard',
        responseText: '42',
        sessionId: 'session-1',
      }),
    ).resolves.toMatchObject({ feedback: { evidenceQualification: 'assisted' } });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ hintLevel: 1, perceivedDifficulty: 'hard', responseText: '42' }),
      method: 'POST',
    });
  });

  it('rejects malformed scheduling data instead of displaying it', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            cardIds: ['card-1'],
            cards: [{ ...card, schedule: { ...card.schedule, intervalDays: 7, stepIndex: 1 } }],
            createdAt: '2026-09-12T00:00:00.000Z',
            id: 'session-1',
            learningProfileId: 'profile-1',
          },
        }),
        { status: 201 },
      ),
    );
    await expect(
      createReviewCardGateway('https://api.example.test').createSession({
        accessToken: 'token-1',
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  it('rejects a session whose visible cards no longer match its card ids', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            cardIds: ['card-1', 'card-2'],
            cards: [card],
            createdAt: '2026-09-12T00:00:00.000Z',
            id: 'session-1',
            learningProfileId: 'profile-1',
          },
        }),
        { status: 200 },
      ),
    );
    await expect(
      createReviewCardGateway('https://api.example.test').getSession({
        accessToken: 'token-1',
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });
});
