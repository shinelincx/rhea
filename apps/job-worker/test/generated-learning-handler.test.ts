import { describe, expect, it, vi } from 'vitest';

import {
  GeneratedLearningActiveLeaseError,
  createGeneratedLearningJobHandler,
} from '../src/generated-learning-handler.js';

describe('generated learning job handler', () => {
  it('passes only validated opaque identifiers to the processor', async () => {
    const processRequest = vi.fn(async () => ({
      id: 'request-1',
      status: 'ready' as const,
      unavailableReason: null,
    }));
    const handler = createGeneratedLearningJobHandler({ processRequest });

    await expect(
      handler({
        kind: 'generated-learning.generate',
        payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
      }),
    ).resolves.toEqual({
      requestId: 'request-1',
      status: 'ready',
      unavailableReason: null,
    });
    expect(processRequest).toHaveBeenCalledWith({
      learningProfileId: 'profile-1',
      requestId: 'request-1',
    });
  });

  it.each([
    { learningProfileId: '', requestId: 'request-1' },
    { learningProfileId: 'profile-1', requestId: 42 },
  ])('fails closed for malformed payload %#', async (payload) => {
    const handler = createGeneratedLearningJobHandler({
      processRequest: vi.fn(),
    });

    await expect(
      handler({ kind: 'generated-learning.generate', payload } as never),
    ).rejects.toThrow('INVALID_GENERATED_LEARNING_JOB_PAYLOAD');
  });

  it('makes an active processing lease retryable instead of completing the queue job', async () => {
    const processRequest = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'request-1',
        status: 'generating' as const,
        unavailableReason: null,
      })
      .mockResolvedValueOnce({
        id: 'request-1',
        status: 'ready' as const,
        unavailableReason: null,
      });
    const handler = createGeneratedLearningJobHandler({
      processRequest,
    });
    const delivery = {
      kind: 'generated-learning.generate' as const,
      payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
    };

    await expect(handler(delivery)).rejects.toBeInstanceOf(GeneratedLearningActiveLeaseError);
    await expect(handler(delivery)).resolves.toMatchObject({
      requestId: 'request-1',
      status: 'ready',
    });
    expect(processRequest).toHaveBeenCalledTimes(2);
  });
});
