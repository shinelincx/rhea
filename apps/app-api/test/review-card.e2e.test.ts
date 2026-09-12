import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiProcessingConsentPublicationReader, FamilyAccess } from '@rhea/family-access';
import type { ReviewCardRequestView, ReviewCardService } from '@rhea/learning-progress';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/create-app.js';

const requestView: ReviewCardRequestView = {
  aiDisclosure: '我是 AI 学习助手，这张复习卡由 AI 重新生成并经过发布前检查。',
  card: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  id: 'review-request-1',
  learningProfileId: 'profile-1',
  rebuildPending: false,
  status: 'queued',
  unavailableReason: null,
  updatedAt: '2026-09-12T00:00:00.000Z',
};

describe('Review-card HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => app?.close());

  it('resolves authoritative grade/consent, schedules backend AI, and exposes short-review attempts', async () => {
    const familyAccess = {
      async authorizeLearningProfile() {
        return {
          deviceId: 'device-1',
          familySpaceId: 'family-1',
          learningProfileId: 'profile-1',
          type: 'learner' as const,
        };
      },
      async getAiProcessingConsentSnapshotForPublication() {
        return {
          familySpaceId: 'family-1',
          grade: 3 as const,
          learningProfileId: 'profile-1',
          revision: 2,
          statementVersion: 'ai-v1',
          status: 'granted' as const,
          updatedAt: '2026-09-12T00:00:00.000Z',
        };
      },
    } as unknown as FamilyAccess & AiProcessingConsentPublicationReader;
    const requestReviewCard = vi.fn(async () => requestView);
    const createShortReviewSession = vi.fn(async () => ({
      cardIds: ['card-1'],
      cards: [],
      createdAt: '2026-09-12T00:00:00.000Z',
      id: 'session-1',
      learningProfileId: 'profile-1',
    }));
    const submitAttempt = vi.fn(async () => ({
      attempt: { id: 'attempt-1' },
      feedback: { nextIntervalDays: 3, outcome: 'correct' },
    }));
    const reviewCards = {
      createShortReviewSession,
      getRequest: vi.fn(async () => requestView),
      getShortReviewSession: createShortReviewSession,
      processRequest: vi.fn(),
      requestReviewCard,
      submitAttempt,
    } as unknown as ReviewCardService;
    const scheduled: ReviewCardRequestView[] = [];
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      generatedLearningConsentReader: familyAccess,
      reviewCardScheduler: {
        async schedule(request) {
          scheduled.push(request);
        },
      },
      reviewCardService: reviewCards,
    });
    await app.init();
    const base = '/v1/family-spaces/family-1/learning-profiles/profile-1';

    const requested = await app.inject({
      headers: { authorization: 'Bearer learner-token', 'idempotency-key': 'review-idem-1' },
      method: 'POST',
      url: `${base}/wrong-items/wrong-1/review-card-requests`,
    });
    expect(requested.statusCode).toBe(202);
    expect(scheduled).toEqual([requestView]);
    expect(requestReviewCard).toHaveBeenCalledWith(
      expect.objectContaining({
        ageBand: 'middle_primary',
        consentRevision: 2,
        wrongItemId: 'wrong-1',
      }),
    );

    const session = await app.inject({
      headers: { authorization: 'Bearer learner-token' },
      method: 'POST',
      url: `${base}/short-review-sessions`,
    });
    expect(session.statusCode).toBe(201);

    const attempt = await app.inject({
      headers: { authorization: 'Bearer learner-token', 'idempotency-key': 'attempt-idem-1' },
      method: 'POST',
      payload: { hintLevel: 1, perceivedDifficulty: 'hard', responseText: '42' },
      url: `${base}/short-review-sessions/session-1/cards/card-1/attempts`,
    });
    expect(attempt.statusCode).toBe(201);
    expect(attempt.json()).toMatchObject({
      data: { feedback: { nextIntervalDays: 3, outcome: 'correct' } },
    });
    expect(submitAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        hintLevel: 1,
        perceivedDifficulty: 'hard',
        responseText: '42',
      }),
    );
  });

  it('fails closed without an active AI-processing consent', async () => {
    const familyAccess = {
      async authorizeLearningProfile() {
        return {
          deviceId: 'device-1',
          familySpaceId: 'family-1',
          learningProfileId: 'profile-1',
          type: 'learner' as const,
        };
      },
      async getAiProcessingConsentSnapshotForPublication() {
        return null;
      },
    } as unknown as FamilyAccess & AiProcessingConsentPublicationReader;
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      generatedLearningConsentReader: familyAccess,
    });
    await app.init();
    const response = await app.inject({
      headers: { authorization: 'Bearer learner-token', 'idempotency-key': 'review-idem-1' },
      method: 'POST',
      url: '/v1/family-spaces/family-1/learning-profiles/profile-1/wrong-items/wrong-1/review-card-requests',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CONSENT_REQUIRED' } });
  });
});
