export type ReviewSubject = 'chinese' | 'english' | 'mathematics' | 'science';
export type PerceivedDifficulty = 'easy' | 'hard' | 'okay';

export interface MobileReviewCard {
  aiGenerated: true;
  content: {
    aiContentState: 'checked';
    keyChanges: string[];
    knowledgePointName: string;
    methodHint: string;
    orientationHint: string;
    question: string;
    subject: ReviewSubject;
    themeId: string;
  };
  id: string;
  original: {
    collapsedByDefault: true;
    currentLearningBasis: {
      sourceVersionId: string;
      validityEpoch: number;
      versionLabel: string;
    };
    question: string;
    relation: 'generated_from_wrong_item';
    response: string;
    wrongItemId: string;
  };
  schedule: {
    dueAt: string;
    intervalDays: 1 | 3 | 7 | 14 | 30;
    pendingCorrection: boolean;
    stepIndex: 0 | 1 | 2 | 3 | 4;
  };
  sourceVersion: {
    assessmentVersionId: string;
    capabilityVersionId: string;
    classificationRevision: number;
    wrongItemStateRevision: number;
  };
}

export interface MobileShortReviewSession {
  cardIds: string[];
  cards: MobileReviewCard[];
  createdAt: string;
  id: string;
  learningProfileId: string;
}

export interface MobileReviewAttemptResult {
  attempt: {
    cardId: string;
    createdAt: string;
    hintLevel: 0 | 1 | 2;
    id: string;
    idempotencyKey: string;
    outcome: 'correct' | 'incorrect';
    perceivedDifficulty: PerceivedDifficulty | null;
    responseText: string;
    sessionId: string;
  };
  feedback: {
    answer: string;
    currentState: 'pending_correction' | 'scheduled' | 'theme_mastered';
    evidenceQualification: 'assisted' | 'correction_required' | 'independent';
    explanationSteps: string[];
    hintImpact: string;
    nextAction: string;
    nextDueAt: string;
    nextIntervalDays: 1 | 3 | 7 | 14 | 30;
    outcome: 'correct' | 'incorrect';
  };
}

interface ReviewScope {
  accessToken: string;
  familySpaceId: string;
  learningProfileId: string;
}

export interface ReviewCardGateway {
  createSession(input: ReviewScope): Promise<MobileShortReviewSession>;
  getSession(input: ReviewScope & { sessionId: string }): Promise<MobileShortReviewSession>;
  submitAttempt(
    input: ReviewScope & {
      cardId: string;
      hintLevel: 0 | 1 | 2;
      idempotencyKey: string;
      perceivedDifficulty: PerceivedDifficulty | null;
      responseText: string;
      sessionId: string;
    },
  ): Promise<MobileReviewAttemptResult>;
}

export class ReviewCardGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = 'ReviewCardGatewayError';
  }
}

function invalidResponse(): never {
  throw new ReviewCardGatewayError('RESPONSE_INVALID', '复习内容没有通过客户端安全检查。');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 4_000): string {
  if (typeof value !== 'string') return invalidResponse();
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return invalidResponse();
  return normalized;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalidResponse();
  }
  return value as number;
}

function isoDate(value: unknown): string {
  const parsed = text(value, 64);
  return Number.isFinite(Date.parse(parsed)) ? parsed : invalidResponse();
}

function textArray(value: unknown, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return invalidResponse();
  }
  return value.map((item) => text(item, 500));
}

function oneOf<const Values extends readonly (number | string)[]>(
  value: unknown,
  values: Values,
): Values[number] {
  return (typeof value === 'string' || typeof value === 'number') &&
    values.some((candidate) => candidate === value)
    ? (value as Values[number])
    : invalidResponse();
}

const SUBJECTS = ['chinese', 'english', 'mathematics', 'science'] as const;
const INTERVALS = [1, 3, 7, 14, 30] as const;

function reviewCard(value: unknown): MobileReviewCard {
  const candidate = record(value);
  const content = record(candidate.content);
  const original = record(candidate.original);
  const basis = record(original.currentLearningBasis);
  const schedule = record(candidate.schedule);
  const source = record(candidate.sourceVersion);
  const intervalDays = integer(schedule.intervalDays, 1, 30);
  const stepIndex = integer(schedule.stepIndex, 0, 4);
  if (
    !INTERVALS.some((interval) => interval === intervalDays) ||
    INTERVALS[stepIndex] !== intervalDays
  ) {
    return invalidResponse();
  }
  return {
    aiGenerated: candidate.aiGenerated === true ? true : invalidResponse(),
    content: {
      aiContentState: content.aiContentState === 'checked' ? 'checked' : invalidResponse(),
      keyChanges: textArray(content.keyChanges, 1, 4),
      knowledgePointName: text(content.knowledgePointName, 200),
      methodHint: text(content.methodHint, 500),
      orientationHint: text(content.orientationHint, 300),
      question: text(content.question, 1_000),
      subject: oneOf(content.subject, SUBJECTS),
      themeId: text(content.themeId, 200),
    },
    id: text(candidate.id, 200),
    original: {
      collapsedByDefault: original.collapsedByDefault === true ? true : invalidResponse(),
      currentLearningBasis: {
        sourceVersionId: text(basis.sourceVersionId, 200),
        validityEpoch: integer(basis.validityEpoch, 1, Number.MAX_SAFE_INTEGER),
        versionLabel: text(basis.versionLabel, 300),
      },
      question: text(original.question),
      relation:
        original.relation === 'generated_from_wrong_item'
          ? 'generated_from_wrong_item'
          : invalidResponse(),
      response: text(original.response),
      wrongItemId: text(original.wrongItemId, 200),
    },
    schedule: {
      dueAt: isoDate(schedule.dueAt),
      intervalDays: intervalDays as 1 | 3 | 7 | 14 | 30,
      pendingCorrection:
        typeof schedule.pendingCorrection === 'boolean'
          ? schedule.pendingCorrection
          : invalidResponse(),
      stepIndex: stepIndex as 0 | 1 | 2 | 3 | 4,
    },
    sourceVersion: {
      assessmentVersionId: text(source.assessmentVersionId, 200),
      capabilityVersionId: text(source.capabilityVersionId, 200),
      classificationRevision: integer(source.classificationRevision, 1, Number.MAX_SAFE_INTEGER),
      wrongItemStateRevision: integer(source.wrongItemStateRevision, 1, Number.MAX_SAFE_INTEGER),
    },
  };
}

function session(value: unknown, expectedProfileId: string): MobileShortReviewSession {
  const candidate = record(value);
  if (!Array.isArray(candidate.cards) || candidate.cards.length > 5) return invalidResponse();
  const cards = candidate.cards.map(reviewCard);
  const cardIds = textArray(candidate.cardIds, 0, 5);
  if (
    text(candidate.learningProfileId, 200) !== expectedProfileId ||
    cards.length !== cardIds.length ||
    new Set(cardIds).size !== cardIds.length ||
    cards.some((card, index) => card.id !== cardIds[index])
  ) {
    return invalidResponse();
  }
  return {
    cardIds,
    cards,
    createdAt: isoDate(candidate.createdAt),
    id: text(candidate.id, 200),
    learningProfileId: expectedProfileId,
  };
}

function attemptResult(
  value: unknown,
  expected: { cardId: string; sessionId: string },
): MobileReviewAttemptResult {
  const candidate = record(value);
  const attempt = record(candidate.attempt);
  const feedback = record(candidate.feedback);
  const hintLevel = integer(attempt.hintLevel, 0, 2) as 0 | 1 | 2;
  const outcome = oneOf(attempt.outcome, ['correct', 'incorrect'] as const);
  const feedbackOutcome = oneOf(feedback.outcome, ['correct', 'incorrect'] as const);
  if (
    text(attempt.cardId, 200) !== expected.cardId ||
    text(attempt.sessionId, 200) !== expected.sessionId ||
    outcome !== feedbackOutcome
  )
    return invalidResponse();
  return {
    attempt: {
      cardId: expected.cardId,
      createdAt: isoDate(attempt.createdAt),
      hintLevel,
      id: text(attempt.id, 200),
      idempotencyKey: text(attempt.idempotencyKey, 200),
      outcome,
      perceivedDifficulty:
        attempt.perceivedDifficulty === null
          ? null
          : oneOf(attempt.perceivedDifficulty, ['easy', 'okay', 'hard'] as const),
      responseText: text(attempt.responseText),
      sessionId: expected.sessionId,
    },
    feedback: {
      answer: text(feedback.answer, 500),
      currentState: oneOf(feedback.currentState, [
        'pending_correction',
        'scheduled',
        'theme_mastered',
      ] as const),
      evidenceQualification: oneOf(feedback.evidenceQualification, [
        'assisted',
        'correction_required',
        'independent',
      ] as const),
      explanationSteps: textArray(feedback.explanationSteps, 1, 6),
      hintImpact: text(feedback.hintImpact, 500),
      nextAction: text(feedback.nextAction, 500),
      nextDueAt: isoDate(feedback.nextDueAt),
      nextIntervalDays: oneOf(feedback.nextIntervalDays, INTERVALS),
      outcome: feedbackOutcome,
    },
  };
}

export function createReviewCardGateway(baseUrl: string): ReviewCardGateway {
  const root = baseUrl.replace(/\/$/, '');
  const path = (input: ReviewScope) =>
    `/v1/family-spaces/${encodeURIComponent(input.familySpaceId)}/learning-profiles/${encodeURIComponent(input.learningProfileId)}`;
  const headers = (input: ReviewScope) => ({
    Accept: 'application/json',
    Authorization: `Bearer ${input.accessToken}`,
  });
  async function request(url: string, options: RequestInit): Promise<unknown> {
    const response = await fetch(`${root}${url}`, options);
    const envelope = record(await response.json().catch(() => ({})));
    if (!response.ok) {
      const error = envelope.error ? record(envelope.error) : {};
      throw new ReviewCardGatewayError(
        typeof error.code === 'string' ? error.code : 'NETWORK_ERROR',
        typeof error.message === 'string' ? error.message : '短复习暂时无法加载，请稍后再试。',
        typeof error.recovery === 'string' ? error.recovery : undefined,
      );
    }
    return envelope.data;
  }
  return {
    createSession(input) {
      return request(`${path(input)}/short-review-sessions`, {
        headers: headers(input),
        method: 'POST',
      }).then((value) => session(value, input.learningProfileId));
    },
    getSession(input) {
      return request(
        `${path(input)}/short-review-sessions/${encodeURIComponent(input.sessionId)}`,
        {
          headers: headers(input),
          method: 'GET',
        },
      ).then((value) => session(value, input.learningProfileId));
    },
    submitAttempt(input) {
      return request(
        `${path(input)}/short-review-sessions/${encodeURIComponent(input.sessionId)}/cards/${encodeURIComponent(input.cardId)}/attempts`,
        {
          body: JSON.stringify({
            hintLevel: input.hintLevel,
            perceivedDifficulty: input.perceivedDifficulty,
            responseText: input.responseText,
          }),
          headers: {
            ...headers(input),
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
          },
          method: 'POST',
        },
      ).then((value) => attemptResult(value, input));
    },
  };
}
