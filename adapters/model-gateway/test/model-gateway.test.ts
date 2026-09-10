import { expect, it } from 'vitest';

import type { GeneratedLearningPackCandidate, ModelTask } from '@rhea/generated-learning';

import { FixedModelGateway } from '../src/index.js';

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
