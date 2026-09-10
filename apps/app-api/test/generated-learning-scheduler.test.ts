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
      capabilityVersion: {
        adapterVersion: 'adapter-v1',
        availability: 'approved',
        id: 'capability-v1',
        modelVersion: 'model-v1',
        policyVersion: 'policy-v1',
        region: 'cn-shanghai',
        templateVersion: 'template-v1',
      },
      contentState: 'unavailable',
      createdAt: '2026-09-10T08:00:00.000Z',
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
