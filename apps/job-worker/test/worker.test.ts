import { describe, expect, it, vi } from 'vitest';

import { createRoleJobHandler } from '../src/worker.js';

describe('role worker interface', () => {
  it('lets the AI worker process generated learning through an injected handler', async () => {
    const generatedLearningHandler = vi.fn(async () => ({ requestId: 'generation-1' }));
    const handler = createRoleJobHandler('ai', { generatedLearningHandler });

    await expect(
      handler({
        kind: 'generated-learning.generate',
        payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
      }),
    ).resolves.toEqual({ requestId: 'generation-1' });
    expect(generatedLearningHandler).toHaveBeenCalledWith({
      kind: 'generated-learning.generate',
      payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
    });
  });

  it('fails closed when the AI worker has no generated-learning handler', async () => {
    const handler = createRoleJobHandler('ai');

    await expect(
      handler({
        kind: 'generated-learning.generate',
        payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
      }),
    ).rejects.toThrow('JOB_HANDLER_UNAVAILABLE');
  });

  it.each(['domain', 'safety'] as const)(
    'rejects generated-learning jobs in the %s worker without invoking a handler',
    async (role) => {
      const generatedLearningHandler = vi.fn(async () => ({ requestId: 'generation-1' }));
      const handler = createRoleJobHandler(role, { generatedLearningHandler });

      await expect(
        handler({
          kind: 'generated-learning.generate',
          payload: { learningProfileId: 'profile-1', requestId: 'generation-1' },
        }),
      ).rejects.toThrow('JOB_KIND_NOT_ALLOWED_FOR_ROLE');
      expect(generatedLearningHandler).not.toHaveBeenCalled();
    },
  );

  it('preserves the system probe behavior for every worker role', async () => {
    const handler = createRoleJobHandler('domain');

    await expect(
      handler({ kind: 'system.probe', payload: { outcome: 'success' } }),
    ).resolves.toEqual({ message: 'processed' });
    await expect(
      handler({ kind: 'system.probe', payload: { outcome: 'failure' } }),
    ).rejects.toThrow('JOB_HANDLER_FAILED');
  });
});
