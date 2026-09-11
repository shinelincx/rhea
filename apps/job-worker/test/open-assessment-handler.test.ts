import { describe, expect, it, vi } from 'vitest';

import {
  OpenAssessmentActiveLeaseError,
  createOpenAssessmentJobHandler,
} from '../src/open-assessment-handler.js';

describe('open assessment job handler', () => {
  it('passes only validated opaque identifiers to the assessment processor', async () => {
    const processSuggestion = vi.fn(async () => ({
      id: 'suggestion-1',
      status: 'pending_review' as const,
      unavailableReason: null,
    }));
    const handler = createOpenAssessmentJobHandler({ processSuggestion });

    await expect(
      handler({
        kind: 'open-assessment.generate',
        payload: { learningProfileId: 'profile-1', suggestionId: 'suggestion-1' },
      }),
    ).resolves.toEqual({
      status: 'pending_review',
      suggestionId: 'suggestion-1',
      unavailableReason: null,
    });
    expect(processSuggestion).toHaveBeenCalledWith({
      learningProfileId: 'profile-1',
      suggestionId: 'suggestion-1',
    });
  });

  it('turns an active generation lease into a retryable worker failure', async () => {
    const handler = createOpenAssessmentJobHandler({
      processSuggestion: async () => ({
        id: 'suggestion-1',
        status: 'generating',
        unavailableReason: null,
      }),
    });
    await expect(
      handler({
        kind: 'open-assessment.generate',
        payload: { learningProfileId: 'profile-1', suggestionId: 'suggestion-1' },
      }),
    ).rejects.toBeInstanceOf(OpenAssessmentActiveLeaseError);
  });
});
