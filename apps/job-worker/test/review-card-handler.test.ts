import { describe, expect, it, vi } from 'vitest';

import {
  ReviewCardActiveLeaseError,
  createReviewCardJobHandler,
} from '../src/review-card-handler.js';

describe('review-card job handler', () => {
  it('passes validated identifiers to the backend processor', async () => {
    const processRequest = vi.fn(async () => ({
      id: 'request-1',
      status: 'ready' as const,
      unavailableReason: null,
    }));
    const handler = createReviewCardJobHandler({ processRequest });
    await expect(
      handler({
        kind: 'review-card.generate',
        payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
      }),
    ).resolves.toEqual({ requestId: 'request-1', status: 'ready', unavailableReason: null });
  });

  it('rejects malformed payloads and retries an active lease', async () => {
    const processRequest = vi.fn(async () => ({
      id: 'request-1',
      status: 'generating' as const,
      unavailableReason: null,
    }));
    const handler = createReviewCardJobHandler({ processRequest });
    await expect(
      handler({
        kind: 'review-card.generate',
        payload: { learningProfileId: '', requestId: 'request-1' },
      }),
    ).rejects.toThrow('INVALID_REVIEW_CARD_JOB_PAYLOAD');
    await expect(
      handler({
        kind: 'review-card.generate',
        payload: { learningProfileId: 'profile-1', requestId: 'request-1' },
      }),
    ).rejects.toBeInstanceOf(ReviewCardActiveLeaseError);
  });
});
