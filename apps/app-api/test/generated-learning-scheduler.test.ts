import { createMemoryJobRuntime } from '@rhea/job-runtime';
import { describe, expect, it, vi } from 'vitest';

import { createQueuedGeneratedLearningScheduler } from '../src/generated-learning/create-queued-generated-learning-scheduler.js';

describe('generated learning scheduler', () => {
  it('queues only the opaque request and profile identifiers for the AI worker', async () => {
    const runtime = createMemoryJobRuntime();
    const scheduler = createQueuedGeneratedLearningScheduler(runtime);
    const handler = vi.fn(async () => ({ status: 'processed' }));

    await scheduler.schedule({
      aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。',
      authorizationDecision: {
        containmentEpoch: 1,
        id: 'authorization-1',
        issuedAt: '2026-09-10T08:00:00.000Z',
      },
      capabilityVersion: {
        adapter: { id: 'adapter', version: 'adapter-v1' },
        artifactHash: 'a'.repeat(64),
        capabilityKey: 'ai.generated-learning',
        id: 'capability-v1',
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
      contentState: 'unavailable',
      createdAt: '2026-09-10T08:00:00.000Z',
      degraded: null,
      familySpaceId: 'family-private',
      generatedContent: null,
      id: 'request-1',
      learningProfileId: 'profile-1',
      materialId: 'material-private',
      purpose: 'learning_pack',
      revealedHintLevel: 0,
      sourceVersion: {
        basisSelectionVersion: 1,
        basisSourceVersionId: 'source-private',
        basisValidityEpoch: 1,
        classificationRevision: 1,
        confirmedContentVersionId: 'content-private',
        versionLabel: '第 1 版',
      },
      status: 'queued',
      unavailableReason: null,
      updatedAt: '2026-09-10T08:00:00.000Z',
    });
    await runtime.workNext(handler);

    expect(handler).toHaveBeenCalledWith({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
    });
  });
});
