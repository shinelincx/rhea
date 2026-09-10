import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { GeneratedLearningCard } from '../src/generated-learning/GeneratedLearningCard';
import {
  GeneratedLearningGatewayError,
  type GeneratedLearningGateway,
  type MobileGeneratedLearningRequest,
} from '../src/generated-learning/generated-learning-gateway';

jest.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `generation-key-${++sequence}` };
});

function requestAtLevel(level: 0 | 1 | 2 | 3): MobileGeneratedLearningRequest {
  return {
    aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。',
    authorizationDecision: {
      containmentEpoch: 1,
      id: 'authorization-1',
      issuedAt: '2026-09-10T00:00:00.000Z',
    },
    capabilityVersion: {
      adapter: { id: 'adapter', version: 'adapter-v1' },
      artifactHash: 'a'.repeat(64),
      capabilityKey: 'ai.generated-learning',
      id: 'learning-pack-v1',
      implementedBy: 'engineer-1',
      kind: 'ai',
      modelOrEngine: { id: 'model', version: 'model-v1' },
      policyVersion: 'policy-v1',
      promptOrConfig: { kind: 'prompt', version: 'prompt-v1' },
      provider: { id: 'provider', version: 'provider-v1' },
      region: 'cn-shanghai',
      registeredAt: '2026-09-01T00:00:00.000Z',
      requiredSlicePolicyVersion: 'quality-policy-v1',
      templateVersion: 'template-v1',
    },
    contentState: 'direct_learning',
    createdAt: '2026-09-10T00:00:00.000Z',
    degraded: null,
    familySpaceId: 'family-a',
    generatedContent: {
      fullExplanation:
        level >= 3 ? { answer: '42', steps: ['先列式：6 × 7', '再计算得到结果'] } : null,
      keyTerms: [{ sourceRegionIds: ['question-1'], term: '乘法' }],
      methodHint: level >= 2 ? '把相同的数相加改写成乘法。' : null,
      orientationHint: level >= 1 ? '先找一找每组数量和组数。' : null,
      quiz: [{ id: 'quiz-1', question: '5 组 8 个，一共有多少个？' }],
      summary: { keyPoints: ['乘法表示相同加数的简便运算。'], title: '认识乘法' },
      supplementalNotes: [],
      variations: [{ id: 'variation-1', question: '7 盒彩笔，每盒 6 支，共多少支？' }],
    },
    id: 'request-1',
    learningProfileId: 'profile-a',
    materialId: 'material-1',
    purpose: 'learning_pack',
    revealedHintLevel: level,
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

function gateway(overrides: Partial<GeneratedLearningGateway> = {}): GeneratedLearningGateway {
  return {
    cancel: jest.fn(),
    get: jest.fn(),
    request: jest.fn(async () => requestAtLevel(0)),
    revealNextHint: jest
      .fn()
      .mockResolvedValueOnce(requestAtLevel(1))
      .mockResolvedValueOnce(requestAtLevel(2))
      .mockResolvedValueOnce(requestAtLevel(3)),
    ...overrides,
  };
}

const props = {
  accessToken: 'learner-token',
  familySpaceId: 'family-a',
  learningProfileId: 'profile-a',
  materialId: 'material-1',
  processingJobId: 'job-1',
};

describe('generated learning card', () => {
  it('reveals orientation, method, and the full explanation in order without a default answer', async () => {
    const generatedLearningGateway = gateway();
    const view = await render(
      <GeneratedLearningCard {...props} gateway={generatedLearningGateway} />,
    );

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });

    expect(
      await view.findByText('我是 AI 学习助手，内容由 AI 生成并经过发布前检查。'),
    ).toBeVisible();
    expect(view.getByText('生成任务：已就绪')).toBeVisible();
    expect(view.getByText('内容状态：可直接学习')).toBeVisible();
    expect(view.getByText('来源版本：确认内容第 1 版 · 选择 2 · 归类 1')).toBeVisible();
    expect(view.getByText('能力版本：learning-pack-v1')).toBeVisible();
    expect(view.getByText('乘法')).toBeVisible();
    expect(view.getByText('来源片段：question-1')).toBeVisible();
    expect(view.getByText('总体来源：确认内容第 1 版')).toBeVisible();
    expect(view.getByText('认识乘法')).toBeVisible();
    expect(view.getByText('乘法表示相同加数的简便运算。')).toBeVisible();
    expect(view.getByText('5 组 8 个，一共有多少个？')).toBeVisible();
    expect(view.getByText('7 盒彩笔，每盒 6 支，共多少支？')).toBeVisible();
    expect(view.queryByText('答案：42')).toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '先看方向提示' }));
    });
    expect(await view.findByText('先找一找每组数量和组数。')).toBeVisible();
    expect(view.queryByText('答案：42')).toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '再看方法提示' }));
    });
    expect(await view.findByText('把相同的数相加改写成乘法。')).toBeVisible();
    expect(view.queryByText('答案：42')).toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '查看完整分步讲解' }));
    });
    expect(await view.findByText('先列式：6 × 7')).toBeVisible();
    expect(view.getByText('答案：42')).toBeVisible();
    expect(generatedLearningGateway.revealNextHint).toHaveBeenCalledTimes(3);
    expect(
      (generatedLearningGateway.revealNextHint as jest.Mock).mock.calls.map(
        ([input]) => input.expectedLevel,
      ),
    ).toEqual([0, 1, 2]);
    expect(view.getByText('AI 学习内容已准备好，可以开始复习。').props).toMatchObject({
      accessibilityLiveRegion: 'polite',
    });
  });

  it('fails closed and hides returned content when the request is unavailable', async () => {
    const unavailable: MobileGeneratedLearningRequest = {
      ...requestAtLevel(3),
      contentState: 'unavailable',
      status: 'unavailable',
      unavailableReason: 'SOURCE_CHANGED',
    };
    const view = await render(
      <GeneratedLearningCard
        {...props}
        gateway={gateway({ request: jest.fn(async () => unavailable) })}
      />,
    );

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });

    expect(await view.findByText('AI 学习内容暂不可用')).toBeVisible();
    expect(view.getByText('当前学习依据已更新，请重新整理后再生成。')).toBeVisible();
    expect(view.queryByText('认识乘法')).toBeNull();
    expect(view.queryByText('答案：42')).toBeNull();
  });

  it('requires three local successful reveals even when the server forges level three', async () => {
    const forged = requestAtLevel(3);
    const revealNextHint = jest.fn(async () => forged);
    const view = await render(
      <GeneratedLearningCard
        {...props}
        gateway={gateway({ request: jest.fn(async () => forged), revealNextHint })}
      />,
    );

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });
    expect(view.queryByText('先找一找每组数量和组数。')).toBeNull();
    expect(view.queryByText('把相同的数相加改写成乘法。')).toBeNull();
    expect(view.queryByText('答案：42')).toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '先看方向提示' }));
    });
    expect(view.getByText('先找一找每组数量和组数。')).toBeVisible();
    expect(view.queryByText('把相同的数相加改写成乘法。')).toBeNull();
    expect(view.queryByText('答案：42')).toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '再看方法提示' }));
    });
    expect(view.getByText('把相同的数相加改写成乘法。')).toBeVisible();
    expect(view.queryByText('答案：42')).toBeNull();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '查看完整分步讲解' }));
    });
    expect(view.getByText('答案：42')).toBeVisible();
  });

  it('polls queued and generating requests until learning content is ready', async () => {
    const queued: MobileGeneratedLearningRequest = {
      ...requestAtLevel(0),
      contentState: 'unavailable',
      generatedContent: null,
      status: 'queued',
    };
    const generating: MobileGeneratedLearningRequest = {
      ...queued,
      status: 'generating',
      updatedAt: '2026-09-10T00:00:01.000Z',
    };
    const get = jest
      .fn()
      .mockResolvedValueOnce(generating)
      .mockResolvedValueOnce(requestAtLevel(0));
    const view = await render(
      <GeneratedLearningCard
        {...props}
        gateway={gateway({ get, request: jest.fn(async () => queued) })}
      />,
    );

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });
    expect(await view.findByText('生成任务：排队中')).toBeVisible();
    expect(view.getByText('内容状态：尚未生成')).toBeVisible();

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2), { timeout: 2_500 });
    expect(await view.findByText('认识乘法')).toBeVisible();
    expect(view.queryByText('答案：42')).toBeNull();
  });

  it('does not let a late poll overwrite a successful cancellation', async () => {
    const queued: MobileGeneratedLearningRequest = {
      ...requestAtLevel(0),
      contentState: 'unavailable',
      generatedContent: null,
      status: 'queued',
    };
    const canceled: MobileGeneratedLearningRequest = {
      ...queued,
      status: 'canceled',
      unavailableReason: 'GENERATION_CANCELED',
    };
    let resolvePoll!: (value: MobileGeneratedLearningRequest) => void;
    const get = jest.fn(
      async () =>
        new Promise<MobileGeneratedLearningRequest>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    const view = await render(
      <GeneratedLearningCard
        {...props}
        gateway={gateway({
          cancel: jest.fn(async () => canceled),
          get,
          request: jest.fn(async () => queued),
        })}
      />,
    );

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1), { timeout: 1_200 });
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '取消生成' }));
    });
    expect(await view.findByText('生成任务：已取消')).toBeVisible();

    await act(async () => {
      resolvePoll(requestAtLevel(0));
    });
    expect(view.getByText('生成任务：已取消')).toBeVisible();
    expect(view.queryByText('认识乘法')).toBeNull();
  });

  it('retries terminal requests with a new idempotency key', async () => {
    const unavailable: MobileGeneratedLearningRequest = {
      ...requestAtLevel(0),
      contentState: 'unavailable',
      generatedContent: null,
      status: 'unavailable',
      unavailableReason: 'MODEL_UNAVAILABLE',
    };
    const request = jest
      .fn()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(requestAtLevel(0));
    const view = await render(<GeneratedLearningCard {...props} gateway={gateway({ request })} />);

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '重新生成' }));
    });

    expect(await view.findByText('认识乘法')).toBeVisible();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0].idempotencyKey).not.toBe(
      request.mock.calls[1]![0].idempotencyKey,
    );
  });

  it('stops polling after a permanent response validation error', async () => {
    const queued: MobileGeneratedLearningRequest = {
      ...requestAtLevel(0),
      contentState: 'unavailable',
      generatedContent: null,
      status: 'queued',
    };
    const get = jest.fn(async () => {
      throw new GeneratedLearningGatewayError('RESPONSE_INVALID', '响应无效');
    });
    const view = await render(
      <GeneratedLearningCard
        {...props}
        gateway={gateway({ get, request: jest.fn(async () => queued) })}
      />,
    );

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '生成 AI 学习内容' }));
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1), { timeout: 1_200 });
    expect(await view.findByText('生成状态无法继续更新，请取消后重新生成。')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
