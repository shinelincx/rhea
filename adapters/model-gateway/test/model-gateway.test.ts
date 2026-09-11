import { afterEach, expect, it, vi } from 'vitest';

import type { GeneratedLearningPackCandidate, ModelTask } from '@rhea/generated-learning';

import {
  FixedModelGateway,
  HttpOpenAssessmentModelGateway,
  createConfiguredOpenAssessmentModelGateway,
} from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

it('returns cloned fixed structured output and records the minimized task', async () => {
  const candidate = {
    fullExplanation: { answer: '4', steps: ['2 加 2 得到 4。'] },
    keyTerms: [{ sourceRegionIds: ['source-1'], term: '加法' }],
    methodHint: '想一想两个 2 合起来有多少。',
    orientationHint: '先找到两个加数。',
    quiz: [],
    summary: { keyPoints: ['相同单位的数可以相加。'], title: '认识加法' },
    supplementalNotes: [],
    variations: [],
  } satisfies GeneratedLearningPackCandidate;
  const task = {
    ageBand: 'lower_primary',
    capability: {
      adapter: { id: 'fixed', version: 'fixed-v1' },
      artifactHash: 'a'.repeat(64),
      capabilityKey: 'ai.generated-learning',
      id: 'capability-1',
      implementedBy: 'engineer-1',
      kind: 'ai',
      modelOrEngine: { id: 'model', version: 'model-v1' },
      policyVersion: 'policy-v1',
      promptOrConfig: { kind: 'prompt', version: 'prompt-v1' },
      provider: { id: 'fixed-test-model', version: 'provider-v1' },
      region: 'test-local',
      registeredAt: '2026-09-01T00:00:00.000Z',
      requiredSlicePolicyVersion: 'quality-policy-v1',
      templateVersion: 'template-v1',
    },
    hintPolicy: 'orientation_then_method_then_full_explanation',
    maxQuizItems: 5,
    purpose: 'learning_pack',
    riskLevel: 'medium',
    sourceBasis: {
      kind: 'learning_material',
    },
    subject: 'mathematics',
    untrustedSourceExcerpts: [],
  } satisfies ModelTask;
  const gateway = new FixedModelGateway([{ candidate }]);

  const result = await gateway.runStructured(task);
  result.candidate.summary.title = 'changed';

  expect(candidate.summary.title).toBe('认识加法');
  expect(gateway.tasks).toEqual([task]);
});

it('posts an open assessment task to the configured backend model gateway', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        candidate: { confidence: 0.9, dimensions: [] },
        externalTraceId: 'trace-1',
        inputTokens: 10,
        outputTokens: 20,
        provider: 'approved-provider',
      }),
      { status: 200 },
    ),
  );
  const gateway = new HttpOpenAssessmentModelGateway({
    authorizationToken: 'secret-token',
    url: 'https://model.example/v1/structured',
  });
  const task = { purpose: 'open_assessment_suggestion' } as never;

  await expect(gateway.runStructured(task)).resolves.toMatchObject({
    externalTraceId: 'trace-1',
    provider: 'approved-provider',
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://model.example/v1/structured',
    expect.objectContaining({
      body: JSON.stringify({ task }),
      headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
      method: 'POST',
    }),
  );
});

it('fails production startup when the backend model gateway is not configured', () => {
  expect(() => createConfiguredOpenAssessmentModelGateway({ NODE_ENV: 'production' })).toThrow(
    'MODEL_GATEWAY_URL is required',
  );
  expect(() =>
    createConfiguredOpenAssessmentModelGateway({
      MODEL_GATEWAY_URL: 'https://model.example/v1/structured',
      NODE_ENV: 'production',
    }),
  ).toThrow('MODEL_GATEWAY_TOKEN is required');
  expect(() =>
    createConfiguredOpenAssessmentModelGateway({
      MODEL_GATEWAY_TIMEOUT_MS: 'not-a-number',
      MODEL_GATEWAY_URL: 'https://model.example/v1/structured',
    }),
  ).toThrow('MODEL_GATEWAY_TIMEOUT_MS');
});
