import type { ReviewCardStore } from './review-card-store.js';
import type {
  ReviewCardAttempt,
  ShortReviewSession,
  StoredReviewCard,
  StoredReviewCardRequest,
} from './review-card-types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryReviewCardStore implements ReviewCardStore {
  readonly #attempts = new Map<string, ReviewCardAttempt>();
  readonly #cards = new Map<string, StoredReviewCard>();
  readonly #requests = new Map<string, StoredReviewCardRequest>();
  readonly #sessions = new Map<string, ShortReviewSession>();

  async createReviewCardRequest(request: StoredReviewCardRequest): Promise<boolean> {
    if (
      [...this.#requests.values()].some(
        (candidate) =>
          candidate.learningProfileId === request.learningProfileId &&
          candidate.idempotencyKey === request.idempotencyKey,
      )
    ) {
      return false;
    }
    this.#requests.set(request.id, clone(request));
    return true;
  }

  async findReviewCardRequestByIdempotencyKey(
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<StoredReviewCardRequest | null> {
    const request = [...this.#requests.values()].find(
      (candidate) =>
        candidate.learningProfileId === learningProfileId &&
        candidate.idempotencyKey === idempotencyKey,
    );
    return request ? clone(request) : null;
  }

  async findReviewCardRequestById(
    id: string,
    learningProfileId: string,
  ): Promise<StoredReviewCardRequest | null> {
    const request = this.#requests.get(id);
    return request?.learningProfileId === learningProfileId ? clone(request) : null;
  }

  async markReviewCardGenerating(
    input: Parameters<ReviewCardStore['markReviewCardGenerating']>[0],
  ): Promise<boolean> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.stateRevision !== input.expectedStateRevision ||
      !(
        request.status === 'queued' ||
        (request.status === 'generating' &&
          request.processingLeaseExpiresAt !== null &&
          Date.parse(request.processingLeaseExpiresAt) <= Date.parse(input.updatedAt))
      )
    ) {
      return false;
    }
    request.processingLeaseExpiresAt = input.leaseExpiresAt;
    request.stateRevision += 1;
    request.status = 'generating';
    request.updatedAt = input.updatedAt;
    return true;
  }

  async completeReviewCardRequest(
    input: Parameters<ReviewCardStore['completeReviewCardRequest']>[0],
  ): Promise<
    | 'capability_contained'
    | 'capability_unavailable'
    | 'completed'
    | 'conflict'
    | 'consent_withdrawn'
    | 'source_changed'
  > {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.stateRevision !== input.expectedStateRevision ||
      request.status !== 'generating' ||
      request.source.wrongItemStateRevision !== input.card.source.wrongItemStateRevision
    ) {
      return 'conflict';
    }
    this.#cards.set(input.card.id, clone(input.card));
    request.currentCardId = input.card.id;
    request.latestChecks = clone(input.card.checks);
    request.modelRuns = clone(input.modelRuns);
    request.processingLeaseExpiresAt = null;
    request.stateRevision += 1;
    request.status = 'ready';
    request.updatedAt = input.card.createdAt;
    return 'completed';
  }

  async failReviewCardRequest(
    input: Parameters<ReviewCardStore['failReviewCardRequest']>[0],
  ): Promise<boolean> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.stateRevision !== input.expectedStateRevision ||
      !['queued', 'generating'].includes(request.status)
    ) {
      return false;
    }
    request.latestChecks = clone(input.latestChecks);
    request.modelRuns = clone(input.modelRuns);
    request.processingLeaseExpiresAt = null;
    request.stateRevision += 1;
    request.status = 'unavailable';
    request.unavailableReason = input.reason;
    request.updatedAt = input.updatedAt;
    return true;
  }

  async invalidateReviewCard(
    input: Parameters<ReviewCardStore['invalidateReviewCard']>[0],
  ): Promise<boolean> {
    const request = this.#requests.get(input.requestId);
    if (
      !request ||
      request.learningProfileId !== input.learningProfileId ||
      request.stateRevision !== input.expectedStateRevision ||
      request.status !== 'ready'
    ) {
      return false;
    }
    const card = request.currentCardId ? this.#cards.get(request.currentCardId) : null;
    if (card) card.status = 'stale';
    request.rebuildPending = true;
    request.stateRevision += 1;
    request.status = 'unavailable';
    request.unavailableReason = input.reason;
    request.updatedAt = input.updatedAt;
    return true;
  }

  async findReviewCardById(
    id: string,
    learningProfileId: string,
  ): Promise<StoredReviewCard | null> {
    const card = this.#cards.get(id);
    return card?.learningProfileId === learningProfileId ? clone(card) : null;
  }

  async listActiveReviewCards(learningProfileId: string): Promise<StoredReviewCard[]> {
    return [...this.#cards.values()]
      .filter((card) => card.learningProfileId === learningProfileId && card.status === 'active')
      .map(clone);
  }

  async createShortReviewSession(session: ShortReviewSession): Promise<boolean> {
    if (this.#sessions.has(session.id)) return false;
    this.#sessions.set(session.id, clone(session));
    return true;
  }

  async findShortReviewSession(
    id: string,
    learningProfileId: string,
  ): Promise<ShortReviewSession | null> {
    const session = this.#sessions.get(id);
    return session?.learningProfileId === learningProfileId ? clone(session) : null;
  }

  async findReviewAttemptByIdempotencyKey(
    cardId: string,
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<ReviewCardAttempt | null> {
    const attempt = this.#attempts.get(`${learningProfileId}:${cardId}:${idempotencyKey}`);
    return attempt ? clone(attempt) : null;
  }

  async recordReviewAttempt(
    input: Parameters<ReviewCardStore['recordReviewAttempt']>[0],
  ): Promise<boolean> {
    const key = `${input.learningProfileId}:${input.attempt.cardId}:${input.attempt.idempotencyKey}`;
    if (this.#attempts.has(key)) return true;
    const card = this.#cards.get(input.attempt.cardId);
    if (
      !card ||
      card.learningProfileId !== input.learningProfileId ||
      card.status !== 'active' ||
      JSON.stringify(card.schedule) !== JSON.stringify(input.expectedSchedule)
    ) {
      return false;
    }
    this.#attempts.set(key, clone(input.attempt));
    card.schedule = clone(input.attempt.scheduleAfter);
    return true;
  }
}
