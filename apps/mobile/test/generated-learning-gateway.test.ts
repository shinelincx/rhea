import {
  createGeneratedLearningGateway,
  GeneratedLearningGatewayError,
  type MobileGeneratedLearningRequest,
} from '../src/generated-learning/generated-learning-gateway';

function validReadyResponse(): MobileGeneratedLearningRequest {
  return {
    aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。',
    capabilityVersion: {
      adapterVersion: 'adapter-v1',
      availability: 'approved',
      id: 'learning-pack-v1',
      modelVersion: 'model-v1',
      policyVersion: 'policy-v1',
      region: 'cn-shanghai',
      templateVersion: 'template-v1',
    },
    contentState: 'direct_learning',
    createdAt: '2026-09-10T00:00:00.000Z',
    familySpaceId: 'family-a',
    generatedContent: {
      fullExplanation: null,
      keyTerms: [{ sourceRegionIds: ['question-1'], term: '乘法' }],
      methodHint: null,
      orientationHint: null,
      quiz: [{ id: 'quiz-1', question: '5 组 8 个是多少？' }],
      summary: { keyPoints: ['乘法表示几个相同的数相加。'], title: '认识乘法' },
      supplementalNotes: [],
      variations: [{ id: 'variation-1', question: '6 组 7 个是多少？' }],
    },
    id: 'request-1',
    learningProfileId: 'profile-a',
    materialId: 'material-1',
    purpose: 'learning_pack',
    revealedHintLevel: 0,
    sourceVersion: {
      basisSelectionVersion: 2,
      basisSourceVersionId: 'source-1',
      basisValidityEpoch: 1,
      classificationRevision: 1,
      confirmedContentVersionId: 'content-1',
      versionLabel: '确认内容第 1 版',
    },
    status: 'ready',
    unavailableReason: null,
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

describe('generated learning mobile gateway', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates a request with the current processing job and a stable idempotency key', async () => {
    const response = {
      aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。' as const,
      capabilityVersion: {
        adapterVersion: 'adapter-v1',
        availability: 'approved' as const,
        id: 'learning-pack-v1',
        modelVersion: 'model-v1',
        policyVersion: 'policy-v1',
        region: 'cn-shanghai',
        templateVersion: 'template-v1',
      },
      contentState: 'unavailable' as const,
      createdAt: '2026-09-10T00:00:00.000Z',
      familySpaceId: 'family a',
      generatedContent: null,
      id: 'request-1',
      learningProfileId: 'profile/1',
      materialId: 'material?1',
      purpose: 'learning_pack' as const,
      revealedHintLevel: 0 as const,
      sourceVersion: {
        basisSelectionVersion: 2,
        basisSourceVersionId: 'source-1',
        basisValidityEpoch: 1,
        classificationRevision: 1,
        confirmedContentVersionId: 'content-1',
        versionLabel: '确认内容第 1 版',
      },
      status: 'queued' as const,
      unavailableReason: null,
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    const fetchMock = jest.fn(async () => ({
      json: async () => ({ data: response }),
      ok: true,
      status: 202,
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    const gateway = createGeneratedLearningGateway('http://127.0.0.1:3000/');

    await expect(
      gateway.request({
        accessToken: 'learner-token',
        familySpaceId: 'family a',
        idempotencyKey: 'generation-key-1',
        learningProfileId: 'profile/1',
        materialId: 'material?1',
        processingJobId: 'job-1',
      }),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/family-spaces/family%20a/learning-profiles/profile%2F1/learning-materials/material%3F1/generated-learning-requests',
      {
        body: JSON.stringify({ processingJobId: 'job-1' }),
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer learner-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'generation-key-1',
        },
        method: 'POST',
      },
    );
  });

  it('gets, reveals, and cancels a profile-scoped request through the documented routes', async () => {
    const response = { ...validReadyResponse(), id: 'request/1' };
    const fetchMock = jest.fn(async () => ({
      json: async () => ({ data: response }),
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    const gateway = createGeneratedLearningGateway('http://127.0.0.1:3000');
    const scope = {
      accessToken: 'learner-token',
      familySpaceId: 'family-a',
      learningProfileId: 'profile-a',
      materialId: 'material-1',
      requestId: 'request/1',
    };

    await gateway.get(scope);
    await gateway.revealNextHint({ ...scope, expectedLevel: 0 });
    await gateway.cancel(scope);

    const root =
      'http://127.0.0.1:3000/v1/family-spaces/family-a/learning-profiles/profile-a/generated-learning-requests/request%2F1';
    const headers = { Accept: 'application/json', Authorization: 'Bearer learner-token' };
    expect(fetchMock).toHaveBeenNthCalledWith(1, root, { headers, method: 'GET' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${root}/reveal-next-hint`, {
      body: JSON.stringify({ expectedLevel: 0 }),
      headers: { ...headers, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${root}/cancel`, {
      headers,
      method: 'POST',
    });
  });

  it.each([
    ['scope mismatch', () => ({ ...validReadyResponse(), familySpaceId: 'another-family' })],
    [
      'malformed capability',
      () => ({
        ...validReadyResponse(),
        capabilityVersion: { ...validReadyResponse().capabilityVersion, id: '' },
      }),
    ],
    [
      'too many quiz items',
      () => ({
        ...validReadyResponse(),
        generatedContent: {
          ...validReadyResponse().generatedContent!,
          quiz: Array.from({ length: 6 }, (_, index) => ({
            id: `quiz-${index}`,
            question: `第 ${index + 1} 题`,
          })),
        },
      }),
    ],
    ['inconsistent ready content', () => ({ ...validReadyResponse(), generatedContent: null })],
  ])('fails closed on a %s response', async (_label, responseFactory) => {
    globalThis.fetch = jest.fn(async () => ({
      json: async () => ({ data: responseFactory() }),
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    const gateway = createGeneratedLearningGateway('http://127.0.0.1:3000');

    await expect(
      gateway.request({
        accessToken: 'learner-token',
        familySpaceId: 'family-a',
        idempotencyKey: 'generation-key-1',
        learningProfileId: 'profile-a',
        materialId: 'material-1',
        processingJobId: 'job-1',
      }),
    ).rejects.toMatchObject<Partial<GeneratedLearningGatewayError>>({
      code: 'RESPONSE_INVALID',
    });
  });

  it('rejects a request id mismatch and strips undeclared server fields', async () => {
    const response = {
      ...validReadyResponse(),
      generatedContent: {
        ...validReadyResponse().generatedContent!,
        quiz: [{ answer: '40', id: 'quiz-1', question: '5 组 8 个是多少？' }],
      },
      serverOnlyTrace: 'do-not-expose',
    };
    globalThis.fetch = jest.fn(async () => ({
      json: async () => ({ data: response }),
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    const gateway = createGeneratedLearningGateway('http://127.0.0.1:3000');
    const scope = {
      accessToken: 'learner-token',
      familySpaceId: 'family-a',
      learningProfileId: 'profile-a',
      materialId: 'material-1',
      requestId: 'request-expected',
    };

    await expect(gateway.get(scope)).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });

    response.id = 'request-expected';
    const normalized = await gateway.get(scope);
    expect(normalized).not.toHaveProperty('serverOnlyTrace');
    expect(normalized.generatedContent?.quiz[0]).toEqual({
      id: 'quiz-1',
      question: '5 组 8 个是多少？',
    });
  });

  it('accepts confirmation-recommended content even when no supplemental note is needed', async () => {
    const response = { ...validReadyResponse(), contentState: 'confirmation_recommended' as const };
    globalThis.fetch = jest.fn(async () => ({
      json: async () => ({ data: response }),
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    const gateway = createGeneratedLearningGateway('http://127.0.0.1:3000');

    await expect(
      gateway.get({
        accessToken: 'learner-token',
        familySpaceId: 'family-a',
        learningProfileId: 'profile-a',
        materialId: 'material-1',
        requestId: 'request-1',
      }),
    ).resolves.toMatchObject({ contentState: 'confirmation_recommended' });
  });
});
