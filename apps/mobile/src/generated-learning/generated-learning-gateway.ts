export type MobileGeneratedContentState =
  'direct_learning' | 'confirmation_recommended' | 'unavailable';

export type MobileGenerationRequestStatus =
  'canceled' | 'generating' | 'queued' | 'ready' | 'unavailable';

export type MobileGenerationUnavailableReason =
  | 'CAPABILITY_UNAVAILABLE'
  | 'CONSENT_WITHDRAWN'
  | 'GENERATION_CANCELED'
  | 'GENERATION_CHECK_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'SOURCE_UNAVAILABLE';

export interface MobileGeneratedLearningRequest {
  aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。';
  capabilityVersion: {
    adapterVersion: string;
    availability: 'approved' | 'unavailable';
    id: string;
    modelVersion: string;
    policyVersion: string;
    region: string;
    templateVersion: string;
  };
  contentState: MobileGeneratedContentState;
  createdAt: string;
  familySpaceId: string;
  generatedContent: null | {
    fullExplanation: null | { answer: string; steps: string[] };
    keyTerms: Array<{ sourceRegionIds: string[]; term: string }>;
    methodHint: string | null;
    orientationHint: string | null;
    quiz: Array<{ id: string; question: string }>;
    summary: { keyPoints: string[]; title: string };
    supplementalNotes: string[];
    variations: Array<{ id: string; question: string }>;
  };
  id: string;
  learningProfileId: string;
  materialId: string;
  purpose: 'learning_pack';
  revealedHintLevel: 0 | 1 | 2 | 3;
  sourceVersion: {
    basisSelectionVersion: number;
    basisSourceVersionId: string;
    basisValidityEpoch: number;
    classificationRevision: number;
    confirmedContentVersionId: string;
    versionLabel: string;
  };
  status: MobileGenerationRequestStatus;
  unavailableReason: MobileGenerationUnavailableReason | null;
  updatedAt: string;
}

interface RequestScope {
  accessToken: string;
  familySpaceId: string;
  learningProfileId: string;
}

interface RequestReference extends RequestScope {
  materialId: string;
  requestId: string;
}

interface RevealRequest extends RequestReference {
  expectedLevel: 0 | 1 | 2 | 3;
}

export interface GeneratedLearningGateway {
  cancel(input: RequestReference): Promise<MobileGeneratedLearningRequest>;
  get(input: RequestReference): Promise<MobileGeneratedLearningRequest>;
  request(
    input: RequestScope & {
      idempotencyKey: string;
      materialId: string;
      processingJobId: string;
    },
  ): Promise<MobileGeneratedLearningRequest>;
  revealNextHint(input: RevealRequest): Promise<MobileGeneratedLearningRequest>;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; recovery?: string };
}

export class GeneratedLearningGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = 'GeneratedLearningGatewayError';
  }
}

const AI_DISCLOSURE = '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。' as const;
const CONTENT_STATES = ['direct_learning', 'confirmation_recommended', 'unavailable'] as const;
const REQUEST_STATUSES = ['canceled', 'generating', 'queued', 'ready', 'unavailable'] as const;
const UNAVAILABLE_REASONS = [
  'CAPABILITY_UNAVAILABLE',
  'CONSENT_WITHDRAWN',
  'GENERATION_CANCELED',
  'GENERATION_CHECK_FAILED',
  'MODEL_UNAVAILABLE',
  'SOURCE_CHANGED',
  'SOURCE_UNAVAILABLE',
] as const;

function invalidResponse(): never {
  throw new GeneratedLearningGatewayError(
    'RESPONSE_INVALID',
    'AI 学习内容没有通过客户端安全检查，因此没有展示。',
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidResponse();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maximumLength = 2_000): string {
  if (typeof value !== 'string') {
    return invalidResponse();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    return invalidResponse();
  }
  return normalized;
}

function nullableText(value: unknown, maximumLength = 2_000): string | null {
  return value === null ? null : text(value, maximumLength);
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return invalidResponse();
  }
  return value;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.some((candidate) => candidate === value)) {
    return invalidResponse();
  }
  return value as Values[number];
}

function textArray(value: unknown, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return invalidResponse();
  }
  return value.map((item) => text(item));
}

function isoDate(value: unknown): string {
  const normalized = text(value, 64);
  if (!Number.isFinite(Date.parse(normalized))) {
    return invalidResponse();
  }
  return normalized;
}

function questionList(
  value: unknown,
  minimum: number,
  maximum: number,
): Array<{ id: string; question: string }> {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return invalidResponse();
  }
  const questions = value.map((item) => {
    const candidate = record(item);
    return { id: text(candidate.id, 200), question: text(candidate.question) };
  });
  if (new Set(questions.map(({ id }) => id)).size !== questions.length) {
    return invalidResponse();
  }
  return questions;
}

function generatedContent(
  value: unknown,
  level: 0 | 1 | 2 | 3,
): NonNullable<MobileGeneratedLearningRequest['generatedContent']> {
  const candidate = record(value);
  const summary = record(candidate.summary);
  const keyTermsValue = candidate.keyTerms;
  if (!Array.isArray(keyTermsValue) || keyTermsValue.length === 0 || keyTermsValue.length > 30) {
    return invalidResponse();
  }
  const keyTerms = keyTermsValue.map((item) => {
    const keyTerm = record(item);
    return {
      sourceRegionIds: textArray(keyTerm.sourceRegionIds, 1, 10),
      term: text(keyTerm.term, 200),
    };
  });
  const orientationHint = nullableText(candidate.orientationHint);
  const methodHint = nullableText(candidate.methodHint);
  let fullExplanation: null | { answer: string; steps: string[] } = null;
  if (candidate.fullExplanation !== null) {
    const explanation = record(candidate.fullExplanation);
    fullExplanation = {
      answer: text(explanation.answer),
      steps: textArray(explanation.steps, 1, 8),
    };
  }
  if (
    (level === 0 &&
      (orientationHint !== null || methodHint !== null || fullExplanation !== null)) ||
    (level === 1 &&
      (orientationHint === null || methodHint !== null || fullExplanation !== null)) ||
    (level === 2 &&
      (orientationHint === null || methodHint === null || fullExplanation !== null)) ||
    (level === 3 && (orientationHint === null || methodHint === null || fullExplanation === null))
  ) {
    return invalidResponse();
  }
  return {
    fullExplanation,
    keyTerms,
    methodHint,
    orientationHint,
    quiz: questionList(candidate.quiz, 1, 5),
    summary: {
      keyPoints: textArray(summary.keyPoints, 1, 6),
      title: text(summary.title, 300),
    },
    supplementalNotes: textArray(candidate.supplementalNotes, 0, 5),
    variations: questionList(candidate.variations, 1, 3),
  };
}

function normalizeGeneratedLearningResponse(
  value: unknown,
  expected: {
    familySpaceId: string;
    learningProfileId: string;
    materialId?: string;
    requestId?: string;
  },
): MobileGeneratedLearningRequest {
  const candidate = record(value);
  const status = oneOf(candidate.status, REQUEST_STATUSES);
  const contentState = oneOf(candidate.contentState, CONTENT_STATES);
  const level = integer(candidate.revealedHintLevel, 0);
  if (level > 3) {
    return invalidResponse();
  }
  const revealedHintLevel = level as 0 | 1 | 2 | 3;
  const capabilityValue = record(candidate.capabilityVersion);
  const availability = oneOf(capabilityValue.availability, ['approved', 'unavailable'] as const);
  const capabilityVersion = {
    adapterVersion: text(capabilityValue.adapterVersion, 200),
    availability,
    id: text(capabilityValue.id, 200),
    modelVersion: text(capabilityValue.modelVersion, 200),
    policyVersion: text(capabilityValue.policyVersion, 200),
    region: text(capabilityValue.region, 200),
    templateVersion: text(capabilityValue.templateVersion, 200),
  };
  const sourceValue = record(candidate.sourceVersion);
  const sourceVersion = {
    basisSelectionVersion: integer(sourceValue.basisSelectionVersion, 1),
    basisSourceVersionId: text(sourceValue.basisSourceVersionId, 200),
    basisValidityEpoch: integer(sourceValue.basisValidityEpoch, 1),
    classificationRevision: integer(sourceValue.classificationRevision, 1),
    confirmedContentVersionId: text(sourceValue.confirmedContentVersionId, 200),
    versionLabel: text(sourceValue.versionLabel, 300),
  };
  const unavailableReason =
    candidate.unavailableReason === null
      ? null
      : oneOf(candidate.unavailableReason, UNAVAILABLE_REASONS);
  const normalizedContent =
    candidate.generatedContent === null
      ? null
      : generatedContent(candidate.generatedContent, revealedHintLevel);
  const normalized: MobileGeneratedLearningRequest = {
    aiDisclosure: candidate.aiDisclosure === AI_DISCLOSURE ? AI_DISCLOSURE : invalidResponse(),
    capabilityVersion,
    contentState,
    createdAt: isoDate(candidate.createdAt),
    familySpaceId: text(candidate.familySpaceId, 200),
    generatedContent: normalizedContent,
    id: text(candidate.id, 200),
    learningProfileId: text(candidate.learningProfileId, 200),
    materialId: text(candidate.materialId, 200),
    purpose: candidate.purpose === 'learning_pack' ? 'learning_pack' : invalidResponse(),
    revealedHintLevel,
    sourceVersion,
    status,
    unavailableReason,
    updatedAt: isoDate(candidate.updatedAt),
  };
  if (
    normalized.familySpaceId !== expected.familySpaceId ||
    normalized.learningProfileId !== expected.learningProfileId ||
    (expected.materialId !== undefined && normalized.materialId !== expected.materialId) ||
    (expected.requestId !== undefined && normalized.id !== expected.requestId)
  ) {
    return invalidResponse();
  }
  const isProcessing = status === 'queued' || status === 'generating';
  const isUnavailable = status === 'canceled' || status === 'unavailable';
  if (
    (status === 'ready' &&
      (normalizedContent === null ||
        contentState === 'unavailable' ||
        unavailableReason !== null)) ||
    (isProcessing &&
      (normalizedContent !== null ||
        contentState !== 'unavailable' ||
        unavailableReason !== null ||
        availability !== 'approved' ||
        revealedHintLevel !== 0)) ||
    (isUnavailable &&
      (normalizedContent !== null ||
        contentState !== 'unavailable' ||
        unavailableReason === null)) ||
    (status === 'canceled' && unavailableReason !== 'GENERATION_CANCELED') ||
    (status === 'unavailable' && unavailableReason === 'GENERATION_CANCELED') ||
    (availability === 'unavailable' &&
      (status !== 'unavailable' || unavailableReason !== 'CAPABILITY_UNAVAILABLE')) ||
    (availability === 'approved' && unavailableReason === 'CAPABILITY_UNAVAILABLE') ||
    (normalizedContent !== null &&
      contentState === 'direct_learning' &&
      normalizedContent.supplementalNotes.length > 0) ||
    Date.parse(normalized.updatedAt) < Date.parse(normalized.createdAt)
  ) {
    return invalidResponse();
  }
  return normalized;
}

export function createGeneratedLearningGateway(baseUrl: string): GeneratedLearningGateway {
  const root = baseUrl.replace(/\/$/, '');

  async function request(path: string, options: RequestInit): Promise<unknown> {
    const response = await fetch(`${root}${path}`, options);
    if (!response.ok) {
      const error = ((await response.json().catch(() => ({}))) as ErrorEnvelope).error;
      throw new GeneratedLearningGatewayError(
        error?.code ?? 'NETWORK_ERROR',
        error?.message ?? 'AI 学习内容暂时无法处理，请稍后重试。',
        error?.recovery,
      );
    }
    try {
      return record(await response.json()).data;
    } catch (error) {
      if (error instanceof GeneratedLearningGatewayError) {
        throw error;
      }
      return invalidResponse();
    }
  }

  const pathForProfile = (input: RequestScope) =>
    `/v1/family-spaces/${encodeURIComponent(input.familySpaceId)}/learning-profiles/${encodeURIComponent(input.learningProfileId)}`;
  const pathForRequest = (input: RequestReference) =>
    `${pathForProfile(input)}/generated-learning-requests/${encodeURIComponent(input.requestId)}`;
  const authorization = (accessToken: string) => ({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  return {
    cancel(input) {
      return request(`${pathForRequest(input)}/cancel`, {
        headers: authorization(input.accessToken),
        method: 'POST',
      }).then((value) => normalizeGeneratedLearningResponse(value, { ...input }));
    },
    get(input) {
      return request(pathForRequest(input), {
        headers: authorization(input.accessToken),
        method: 'GET',
      }).then((value) => normalizeGeneratedLearningResponse(value, { ...input }));
    },
    request(input) {
      return request(
        `${pathForProfile(input)}/learning-materials/${encodeURIComponent(input.materialId)}/generated-learning-requests`,
        {
          body: JSON.stringify({ processingJobId: input.processingJobId }),
          headers: {
            ...authorization(input.accessToken),
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
          },
          method: 'POST',
        },
      ).then((value) =>
        normalizeGeneratedLearningResponse(value, {
          familySpaceId: input.familySpaceId,
          learningProfileId: input.learningProfileId,
          materialId: input.materialId,
        }),
      );
    },
    revealNextHint(input) {
      return request(`${pathForRequest(input)}/reveal-next-hint`, {
        body: JSON.stringify({ expectedLevel: input.expectedLevel }),
        headers: { ...authorization(input.accessToken), 'Content-Type': 'application/json' },
        method: 'POST',
      }).then((value) => normalizeGeneratedLearningResponse(value, { ...input }));
    },
  };
}
