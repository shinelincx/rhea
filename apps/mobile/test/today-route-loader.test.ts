import { createTodayRouteLoader } from '../src/today-route/load-today-route';

const validRoute = {
  generatedAt: '2026-09-15T00:00:00.000Z',
  items: [
    {
      action: 'start_review',
      count: 1,
      detail: '一张卡已到期。',
      estimatedMinutes: 5,
      explanation: '到期复习优先。',
      id: 'today:review:card-1',
      isOptional: true,
      kind: 'due_review',
      priority: 4,
      remainingCount: 0,
      sourceTraces: [{ aggregateId: 'card-1' }],
      targetIds: ['card-1'],
      title: '完成今日短复习',
    },
  ],
  learnerProfileId: 'profile/1',
  noPenaltyMessage: '稍后完成不会扣分。',
  policyVersion: 'today-route-v1',
};

describe('today route loader', () => {
  afterEach(() => jest.restoreAllMocks());

  it('loads only the authenticated and scoped learner route', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: validRoute }), { status: 200 }));

    await expect(
      createTodayRouteLoader('https://api.example.test/')({
        accessToken: 'learner-token',
        familySpaceId: 'family 1',
        learningProfileId: 'profile/1',
      }),
    ).resolves.toMatchObject({ items: [{ action: 'start_review' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/family-spaces/family%201/learning-profiles/profile%2F1/today-route',
      { headers: { Accept: 'application/json', Authorization: 'Bearer learner-token' } },
    );
  });

  it('rejects a response for another profile or with inconsistent source counts', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            ...validRoute,
            items: [{ ...validRoute.items[0], count: 2 }],
            learnerProfileId: 'another-profile',
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      createTodayRouteLoader('https://api.example.test')({
        accessToken: 'learner-token',
        familySpaceId: 'family-1',
        learningProfileId: 'profile/1',
      }),
    ).rejects.toThrow(/数量与来源不一致|学习档案不匹配/);
  });
});
