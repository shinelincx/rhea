import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AssessmentActorReference, ObjectiveGradingRule } from '@rhea/assessment';
import type { Subject } from '@rhea/learning-content';
import type { CapabilityUseSlice, CapabilityVersion } from '@rhea/quality-control';

import { LearningProgressError } from './error.js';
import type { AcceptedObjectiveAssessmentReader } from './ports.js';
import type {
  ReviewCardModelGatewayPort,
  ReviewCardPublicationGate,
  ReviewCardQualityControlPort,
} from './review-card-ports.js';
import type { ReviewCardStore } from './review-card-store.js';
import type {
  ReviewAttemptFeedback,
  ReviewCardAgeBand,
  ReviewCardAttempt,
  ReviewCardCandidate,
  ReviewCardCheck,
  ReviewCardModelTask,
  ReviewCardModelRun,
  ReviewCardRequestView,
  ReviewCardSchedule,
  ReviewCardUnavailableReason,
  ReviewCardView,
  ShortReviewSessionView,
  StoredReviewCard,
  StoredReviewCardRequest,
} from './review-card-types.js';
import type { LearningProgressStore } from './store.js';
import type { StoredWrongItem } from './types.js';

const AI_DISCLOSURE = '我是 AI 学习助手，这张复习卡由 AI 重新生成并经过发布前检查。' as const;
const INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;
const PROCESSING_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 2;
const FORBIDDEN_LABELS = /(智力|智商|笨|懒|性格|人格|天赋|身份|不擅长)/i;

const REWRITE_STRATEGIES: Record<Subject, ReviewCardModelTask['constraints']['rewriteStrategy']> = {
  chinese: 'change_text_context_preserve_answer',
  english: 'change_language_context_preserve_answer',
  mathematics: 'change_math_quantities_or_context_preserve_answer',
  science: 'change_science_context_preserve_answer',
};

export interface ReviewCardServiceDependencies {
  assessmentReader: AcceptedObjectiveAssessmentReader;
  clock?: { readonly now: Date };
  modelGateway: ReviewCardModelGatewayPort;
  publicationGate: ReviewCardPublicationGate;
  qualityControl: ReviewCardQualityControlPort;
  reviewCardStore: ReviewCardStore;
  wrongItemStore: LearningProgressStore;
}

function requiredText(value: string, label: string, maximum = 4_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new LearningProgressError(
      'INPUT_INVALID',
      `${label}不能为空且不能超过 ${maximum} 个字符`,
    );
  }
  return normalized;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?;；:：]/g, '')
    .toLowerCase();
}

function normalizedNumber(value: string): string | null {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? String(number) : null;
}

function arithmeticAnswer(question: string): string | null {
  const matches = [...question.matchAll(/(?<!\d)(-?\d+)\s*([+\-×÷*/])\s*(-?\d+)(?!\d)/g)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const left = Number(match[1]);
  const right = Number(match[3]);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
  const result =
    match[2] === '+'
      ? left + right
      : match[2] === '-'
        ? left - right
        : match[2] === '×' || match[2] === '*'
          ? left * right
          : right === 0
            ? Number.NaN
            : left / right;
  return Number.isFinite(result) ? String(result) : null;
}

function ruleAccepts(rule: ObjectiveGradingRule, response: string): boolean {
  if (rule.kind === 'numeric') {
    return (
      normalizedNumber(response) !== null &&
      normalizedNumber(response) === normalizedNumber(rule.expected)
    );
  }
  if (rule.kind === 'single_choice') {
    return normalizedText(response) === normalizedText(rule.correctOption);
  }
  const candidate = rule.collapseWhitespace ? response.replace(/\s+/g, ' ').trim() : response;
  return rule.acceptedAnswers.some((answer) => {
    const expected = rule.collapseWhitespace ? answer.replace(/\s+/g, ' ').trim() : answer;
    return rule.caseSensitive
      ? candidate === expected
      : candidate.toLocaleLowerCase() === expected.toLocaleLowerCase();
  });
}

function isRule(value: unknown): value is ObjectiveGradingRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<ObjectiveGradingRule>;
  if (rule.kind === 'numeric') {
    return (
      typeof rule.expected === 'string' &&
      rule.expected.trim().length > 0 &&
      rule.expected.length <= 500 &&
      normalizedNumber(rule.expected) !== null
    );
  }
  if (rule.kind === 'single_choice') {
    return (
      typeof rule.correctOption === 'string' &&
      rule.correctOption.trim().length > 0 &&
      rule.correctOption.length <= 500
    );
  }
  return (
    rule.kind === 'accepted_text' &&
    Array.isArray(rule.acceptedAnswers) &&
    rule.acceptedAnswers.length > 0 &&
    rule.acceptedAnswers.length <= 10 &&
    rule.acceptedAnswers.every(
      (answer) => typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 500,
    ) &&
    typeof rule.caseSensitive === 'boolean' &&
    typeof rule.collapseWhitespace === 'boolean'
  );
}

function ruleOnlyAcceptsTrustedAnswer(rule: ObjectiveGradingRule, trustedAnswer: string): boolean {
  if (rule.kind === 'numeric') {
    const expected = normalizedNumber(rule.expected);
    const trusted = normalizedNumber(trustedAnswer);
    return expected !== null && trusted !== null && expected === trusted;
  }
  if (rule.kind === 'single_choice') {
    return normalizedText(rule.correctOption) === normalizedText(trustedAnswer);
  }
  return rule.acceptedAnswers.every(
    (answer) => normalizedText(answer) === normalizedText(trustedAnswer),
  );
}

function sanitizeModelText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已移除]')
    .replace(/(?<!\d)1[3-9](?:[\s-]?\d){9}(?!\d)/g, '[手机号已移除]')
    .replace(/(?<!\d)\d{6}[\s-]?\d{8}[\s-]?\d{3}[\dXx](?!\d)/g, '[身份证号已移除]')
    .replace(/((?:姓名|学校|班级|地址|住址)\s*[:：])\s*[^\s，,。；;\n]{1,30}/g, '$1[已移除]')
    .trim();
}

function containsAnswer(text: string, answer: string): boolean {
  const numeric = normalizedNumber(answer);
  if (numeric !== null) {
    return new RegExp(
      `(?<![\\d.])${numeric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`,
    ).test(text);
  }
  return normalizedText(text).includes(normalizedText(answer));
}

function candidateChecks(
  candidate: ReviewCardCandidate,
  request: StoredReviewCardRequest,
): ReviewCardCheck[] {
  const schema =
    typeof candidate.question === 'string' &&
    candidate.question.trim().length > 0 &&
    candidate.question.length <= 1_000 &&
    typeof candidate.expectedAnswer === 'string' &&
    candidate.expectedAnswer.trim().length > 0 &&
    candidate.expectedAnswer.length <= 500 &&
    Array.isArray(candidate.keyChanges) &&
    candidate.keyChanges.length >= 1 &&
    candidate.keyChanges.length <= 4 &&
    candidate.keyChanges.every(
      (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
    ) &&
    Array.isArray(candidate.explanationSteps) &&
    candidate.explanationSteps.length >= 1 &&
    candidate.explanationSteps.length <= 6 &&
    candidate.explanationSteps.every(
      (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500,
    ) &&
    typeof candidate.orientationHint === 'string' &&
    candidate.orientationHint.trim().length > 0 &&
    candidate.orientationHint.length <= 300 &&
    typeof candidate.methodHint === 'string' &&
    candidate.methodHint.trim().length > 0 &&
    candidate.methodHint.length <= 500 &&
    isRule(candidate.gradingRule);
  const candidateQuestion = schema ? normalizedText(candidate.question) : '';
  const originalQuestion = normalizedText(request.source.originalQuestion);
  const rewritten =
    schema &&
    candidateQuestion !== originalQuestion &&
    !candidateQuestion.includes(originalQuestion) &&
    !originalQuestion.includes(candidateQuestion);
  const arithmetic = schema ? arithmeticAnswer(candidate.question) : null;
  const trustedAnswer = arithmetic ?? request.source.originalExpectedAnswer;
  const consistent =
    schema &&
    normalizedText(candidate.expectedAnswer) === normalizedText(trustedAnswer) &&
    ruleAccepts(candidate.gradingRule, candidate.expectedAnswer) &&
    ruleOnlyAcceptsTrustedAnswer(candidate.gradingRule, trustedAnswer) &&
    (arithmetic === null ||
      (candidate.gradingRule.kind === 'numeric' &&
        normalizedNumber(candidate.gradingRule.expected) === arithmetic));
  const visibleHints = schema ? `${candidate.orientationHint}\n${candidate.methodHint}` : '';
  const noLeakage = schema && !containsAnswer(visibleHints, candidate.expectedAnswer);
  const checkedOutput = schema
    ? `${candidate.question}\n${visibleHints}\n${candidate.explanationSteps.join('\n')}`
    : '';
  const safe =
    schema &&
    !FORBIDDEN_LABELS.test(checkedOutput) &&
    sanitizeModelText(checkedOutput) === checkedOutput;
  return [
    {
      detail: schema ? '结构与长度符合约束' : '结构或长度不符合约束',
      kind: 'schema',
      passed: schema,
    },
    {
      detail: rewritten ? '题目已重新表述或变式' : '题目仍复制原题',
      kind: 'rewrite',
      passed: rewritten,
    },
    {
      detail: consistent ? '答案与确定性规则一致' : '答案无法由确定性规则验证',
      kind: 'consistency',
      passed: consistent,
    },
    {
      detail: noLeakage ? '提示未提前泄露答案' : '提示提前泄露答案',
      kind: 'answer_leakage',
      passed: noLeakage,
    },
    {
      detail: safe ? '未发现学习者标签或不安全表达' : '发现学习者标签或不安全表达',
      kind: 'safety',
      passed: safe,
    },
  ];
}

function useSlice(request: StoredReviewCardRequest): CapabilityUseSlice {
  return {
    basisState: 'current',
    gradeBand: request.source.ageBand,
    imageQuality: 'not_applicable',
    questionType: 'objective',
    riskLevel: 'medium',
    subject: request.source.subject,
  };
}

function authorizedCapability(
  decision: Awaited<ReturnType<ReviewCardQualityControlPort['authorizeCapability']>>,
  slice: CapabilityUseSlice,
): CapabilityVersion | null {
  if (
    decision.scope.capabilityKey !== 'ai.review-card' ||
    decision.scope.kind !== 'ai' ||
    !isDeepStrictEqual(decision.scope.slice, slice)
  ) {
    throw new LearningProgressError('CAPABILITY_UNAVAILABLE', '复习卡能力授权决策无效');
  }
  if (decision.status !== 'authorized') return null;
  const capability = decision.primary?.capabilityVersion;
  if (
    !capability ||
    capability.capabilityKey !== 'ai.review-card' ||
    capability.kind !== 'ai' ||
    capability.promptOrConfig.kind !== 'prompt'
  ) {
    throw new LearningProgressError('CAPABILITY_UNAVAILABLE', '复习卡能力版本无效');
  }
  return structuredClone(capability);
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

function viewCard(card: StoredReviewCard): ReviewCardView {
  return {
    aiGenerated: true,
    content: {
      aiContentState: 'checked',
      keyChanges: [...card.candidate.keyChanges],
      knowledgePointName: card.source.knowledgePointName,
      methodHint: card.candidate.methodHint,
      orientationHint: card.candidate.orientationHint,
      question: card.candidate.question,
      subject: card.source.subject,
      themeId: card.source.themeId,
    },
    id: card.id,
    original: {
      collapsedByDefault: true,
      currentLearningBasis: {
        sourceVersionId: card.source.basis.sourceVersionId,
        validityEpoch: card.source.basis.validityEpoch,
        versionLabel: card.source.basis.versionLabel,
      },
      question: card.source.originalQuestion,
      relation: 'generated_from_wrong_item',
      response: card.source.originalResponse,
      wrongItemId: card.source.wrongItemId,
    },
    schedule: structuredClone(card.schedule),
    sourceVersion: {
      assessmentVersionId: card.source.assessmentVersionId,
      capabilityVersionId: card.capabilityVersionId,
      classificationRevision: card.source.classificationRevision,
      wrongItemStateRevision: card.source.wrongItemStateRevision,
    },
  };
}

export class ReviewCardService {
  readonly #assessmentReader: AcceptedObjectiveAssessmentReader;
  readonly #clock: { readonly now: Date };
  readonly #modelGateway: ReviewCardModelGatewayPort;
  readonly #publicationGate: ReviewCardPublicationGate;
  readonly #qualityControl: ReviewCardQualityControlPort;
  readonly #reviewCardStore: ReviewCardStore;
  readonly #wrongItemStore: LearningProgressStore;

  constructor(dependencies: ReviewCardServiceDependencies) {
    this.#assessmentReader = dependencies.assessmentReader;
    this.#clock =
      dependencies.clock ??
      ({
        get now() {
          return new Date();
        },
      } as const);
    this.#modelGateway = dependencies.modelGateway;
    this.#publicationGate = dependencies.publicationGate;
    this.#qualityControl = dependencies.qualityControl;
    this.#reviewCardStore = dependencies.reviewCardStore;
    this.#wrongItemStore = dependencies.wrongItemStore;
  }

  async requestReviewCard(input: {
    actor: AssessmentActorReference;
    ageBand: ReviewCardAgeBand;
    consentRevision: number;
    familySpaceId: string;
    idempotencyKey: string;
    learningProfileId: string;
    wrongItemId: string;
  }): Promise<ReviewCardRequestView> {
    const idempotencyKey = requiredText(input.idempotencyKey, '幂等键', 200);
    const item = await this.#requireEligibleWrongItem(
      input.wrongItemId,
      input.learningProfileId,
      input.actor,
    );
    if (item.familySpaceId !== input.familySpaceId) {
      throw new LearningProgressError('SOURCE_INELIGIBLE', '错题不属于当前家庭空间');
    }
    if (
      item.classification.status !== 'classified' ||
      !item.classification.primaryKnowledgePointName
    ) {
      throw new LearningProgressError('CLASSIFICATION_INVALID', '待归类错题不能生成正式复习卡');
    }
    if (!(await this.#publicationGate.authorize(input))) {
      throw new LearningProgressError('CONSENT_REQUIRED', '需要有效的 AI 处理同意与年级信息');
    }
    const source = {
      ageBand: input.ageBand,
      assessmentId: item.assessment.assessmentId,
      assessmentVersionId: item.assessment.assessmentVersionId,
      basis: structuredClone(item.assessment.basis),
      classificationRevision: item.classification.revision,
      consentRevision: input.consentRevision,
      gradingRuleVersionId: item.assessment.correctBasis.gradingRuleVersionId,
      knowledgePointName: item.classification.primaryKnowledgePointName,
      originalExpectedAnswer: item.assessment.correctBasis.expectedDisplay,
      originalQuestion: item.assessment.question.text,
      originalQuestionContentHash: item.assessment.question.contentHash,
      originalQuestionVersionId: item.assessment.question.versionId,
      originalResponse: item.assessment.response.text,
      originalResponseContentHash: item.assessment.response.contentHash,
      originalResponseVersionId: item.assessment.response.versionId,
      subject: item.classification.subject,
      themeId: item.themeId,
      unitName: item.classification.unitName,
      wrongItemId: item.id,
      wrongItemStateRevision: item.stateRevision,
      wrongItemStatus: item.status,
    } as const;
    const shell = {
      actor: structuredClone(input.actor),
      authorization: { containmentEpoch: 0, decisionId: '', degradedReason: null, issuedAt: '' },
      capability: null,
      createdAt: '',
      currentCardId: null,
      familySpaceId: input.familySpaceId,
      id: '',
      idempotencyKey,
      latestChecks: [],
      learningProfileId: input.learningProfileId,
      modelRuns: [],
      processingLeaseExpiresAt: null,
      rebuildPending: false,
      requestFingerprint: '',
      source,
      stateRevision: 1,
      status: 'queued' as const,
      unavailableReason: null,
      updatedAt: '',
    };
    const decision = await this.#qualityControl.authorizeCapability({
      capabilityKey: 'ai.review-card',
      familySpaceId: input.familySpaceId,
      kind: 'ai',
      slice: useSlice(shell),
    });
    const capability = authorizedCapability(decision, useSlice(shell));
    const requestFingerprint = hash({
      actor: input.actor,
      capability,
      familySpaceId: input.familySpaceId,
      learningProfileId: input.learningProfileId,
      source,
    });
    const existing = await this.#reviewCardStore.findReviewCardRequestByIdempotencyKey(
      idempotencyKey,
      input.learningProfileId,
    );
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        await this.#invalidateIfNeeded(existing);
        throw new LearningProgressError('INPUT_INVALID', '同一幂等键不能用于不同的复习卡请求');
      }
      await this.#invalidateIfNeeded(existing);
      return this.#viewRequest(await this.#requireRequest(existing.id, existing.learningProfileId));
    }
    const now = this.#clock.now.toISOString();
    const request: StoredReviewCardRequest = {
      ...shell,
      authorization: {
        containmentEpoch: decision.containmentEpoch,
        decisionId: decision.decisionId,
        degradedReason: decision.degradedReason,
        issuedAt: decision.issuedAt,
      },
      capability,
      createdAt: now,
      id: randomUUID(),
      requestFingerprint,
      status: capability ? 'queued' : 'unavailable',
      unavailableReason: capability ? null : 'CAPABILITY_UNAVAILABLE',
      updatedAt: now,
    };
    if (!(await this.#reviewCardStore.createReviewCardRequest(request))) {
      const concurrent = await this.#reviewCardStore.findReviewCardRequestByIdempotencyKey(
        idempotencyKey,
        input.learningProfileId,
      );
      if (concurrent?.requestFingerprint === requestFingerprint)
        return this.#viewRequest(concurrent);
      throw new LearningProgressError('VERSION_CONFLICT', '复习卡请求状态已变化');
    }
    return this.#viewRequest(request);
  }

  async processRequest(input: {
    learningProfileId: string;
    requestId: string;
  }): Promise<ReviewCardRequestView> {
    let request = await this.#requireRequest(input.requestId, input.learningProfileId);
    if (request.status === 'ready' || request.status === 'unavailable')
      return this.#viewRequest(request);
    const now = this.#clock.now;
    if (
      request.status === 'generating' &&
      request.processingLeaseExpiresAt &&
      Date.parse(request.processingLeaseExpiresAt) > now.getTime()
    ) {
      return this.#viewRequest(request);
    }
    if (
      request.status !== 'queued' &&
      !(
        request.status === 'generating' &&
        request.processingLeaseExpiresAt !== null &&
        Date.parse(request.processingLeaseExpiresAt) <= now.getTime()
      )
    ) {
      await this.#fail(request, 'MODEL_UNAVAILABLE', [], request.modelRuns);
      return this.#viewRequest(await this.#requireRequest(request.id, request.learningProfileId));
    }
    if (
      !(await this.#reviewCardStore.markReviewCardGenerating({
        expectedStateRevision: request.stateRevision,
        leaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS).toISOString(),
        learningProfileId: request.learningProfileId,
        requestId: request.id,
        updatedAt: now.toISOString(),
      }))
    ) {
      return this.#viewRequest(await this.#requireRequest(request.id, request.learningProfileId));
    }
    request = await this.#requireRequest(request.id, request.learningProfileId);
    const sourceCurrentBeforeGeneration = await this.#isSourceCurrent(request);
    const consentCurrentBeforeGeneration =
      sourceCurrentBeforeGeneration &&
      (await this.#publicationGate.authorize({
        ageBand: request.source.ageBand,
        consentRevision: request.source.consentRevision,
        familySpaceId: request.familySpaceId,
        learningProfileId: request.learningProfileId,
      }));
    if (!sourceCurrentBeforeGeneration || !consentCurrentBeforeGeneration) {
      await this.#fail(
        request,
        sourceCurrentBeforeGeneration ? 'CONSENT_WITHDRAWN' : 'SOURCE_CHANGED',
        [],
        [],
      );
      return this.#viewRequest(await this.#requireRequest(request.id, request.learningProfileId));
    }
    if (!request.capability) {
      await this.#fail(request, 'CAPABILITY_UNAVAILABLE', [], []);
      return this.#viewRequest(await this.#requireRequest(request.id, request.learningProfileId));
    }
    const modelRuns: ReviewCardModelRun[] = [];
    let latestChecks: ReviewCardCheck[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let result: Awaited<ReturnType<ReviewCardModelGatewayPort['runStructured']>>;
      try {
        result = await this.#modelGateway.runStructured({
          ageBand: request.source.ageBand,
          capability: structuredClone(request.capability),
          constraints: {
            answerMustBeDeterministicallyVerifiable: true,
            doNotCopyOriginalQuestion: true,
            hintPolicy: 'orientation_then_method_then_feedback',
            maxExplanationSteps: 6,
            rewriteStrategy: REWRITE_STRATEGIES[request.source.subject],
          },
          knowledgePointName: request.source.knowledgePointName,
          original: {
            expectedAnswer: sanitizeModelText(request.source.originalExpectedAnswer),
            question: sanitizeModelText(request.source.originalQuestion),
            response: sanitizeModelText(request.source.originalResponse),
          },
          purpose: 'review_card',
          riskLevel: 'medium',
          subject: request.source.subject,
          unitName: request.source.unitName,
        });
      } catch {
        modelRuns.push(this.#modelRun(request, attempt, false, null));
        continue;
      }
      modelRuns.push(this.#modelRun(request, attempt, true, result));
      latestChecks = candidateChecks(result.candidate, request);
      if (latestChecks.every(({ passed }) => passed)) {
        const received = await this.#qualityControl.revalidateAuthorization({
          decisionId: request.authorization.decisionId,
          expectedContainmentEpoch: request.authorization.containmentEpoch,
          phase: 'after_receive',
          route: 'primary',
        });
        const publish =
          received.status === 'authorized'
            ? await this.#qualityControl.revalidateAuthorization({
                decisionId: request.authorization.decisionId,
                expectedContainmentEpoch: received.containmentEpoch,
                phase: 'before_publish',
                route: 'primary',
              })
            : received;
        const sourceCurrentBeforePublish = await this.#isSourceCurrent(request);
        const consentCurrentBeforePublish =
          sourceCurrentBeforePublish &&
          (await this.#publicationGate.authorize({
            ageBand: request.source.ageBand,
            consentRevision: request.source.consentRevision,
            familySpaceId: request.familySpaceId,
            learningProfileId: request.learningProfileId,
          }));
        if (
          publish.status !== 'authorized' ||
          !sourceCurrentBeforePublish ||
          !consentCurrentBeforePublish
        ) {
          const reason: ReviewCardUnavailableReason =
            publish.status !== 'authorized'
              ? publish.reason === 'CAPABILITY_CONTAINED'
                ? 'CAPABILITY_CONTAINED'
                : 'CAPABILITY_UNAVAILABLE'
              : sourceCurrentBeforePublish
                ? 'CONSENT_WITHDRAWN'
                : 'SOURCE_CHANGED';
          await this.#fail(request, reason, latestChecks, modelRuns);
          return this.#viewRequest(
            await this.#requireRequest(request.id, request.learningProfileId),
          );
        }
        const createdAt = this.#clock.now.toISOString();
        const card: StoredReviewCard = {
          candidate: structuredClone(result.candidate),
          capabilityVersionId: publish.capabilityVersion.id,
          checks: latestChecks,
          createdAt,
          familySpaceId: request.familySpaceId,
          id: randomUUID(),
          learningProfileId: request.learningProfileId,
          requestId: request.id,
          schedule: {
            dueAt:
              request.source.wrongItemStatus === 'pending_correction'
                ? this.#clock.now.toISOString()
                : addDays(this.#clock.now, 1),
            intervalDays: 1,
            pendingCorrection: request.source.wrongItemStatus === 'pending_correction',
            stepIndex: 0,
          },
          source: structuredClone(request.source),
          status: 'active',
          version: 1,
        };
        const completed = await this.#reviewCardStore.completeReviewCardRequest({
          card,
          expectedStateRevision: request.stateRevision,
          modelRuns,
          requestId: request.id,
        });
        if (completed !== 'completed') {
          if (completed !== 'conflict') {
            const reason: ReviewCardUnavailableReason =
              completed === 'consent_withdrawn'
                ? 'CONSENT_WITHDRAWN'
                : completed === 'capability_contained'
                  ? 'CAPABILITY_CONTAINED'
                  : completed === 'capability_unavailable'
                    ? 'CAPABILITY_UNAVAILABLE'
                    : 'SOURCE_CHANGED';
            await this.#fail(request, reason, latestChecks, modelRuns);
          }
        }
        return this.#viewRequest(await this.#requireRequest(request.id, request.learningProfileId));
      }
    }
    await this.#fail(
      request,
      modelRuns.some(({ succeeded }) => succeeded)
        ? 'GENERATION_CHECK_FAILED'
        : 'MODEL_UNAVAILABLE',
      latestChecks,
      modelRuns,
    );
    return this.#viewRequest(await this.#requireRequest(request.id, request.learningProfileId));
  }

  async getRequest(input: {
    learningProfileId: string;
    requestId: string;
  }): Promise<ReviewCardRequestView> {
    const request = await this.#requireRequest(input.requestId, input.learningProfileId);
    await this.#invalidateIfNeeded(request);
    return this.#viewRequest(await this.#requireRequest(input.requestId, input.learningProfileId));
  }

  async createShortReviewSession(input: {
    actor: AssessmentActorReference;
    learningProfileId: string;
  }): Promise<ShortReviewSessionView> {
    const cards = await this.#reviewCardStore.listActiveReviewCards(input.learningProfileId);
    const eligible: StoredReviewCard[] = [];
    for (const card of cards) {
      const request = await this.#requireRequest(card.requestId, card.learningProfileId);
      await this.#invalidateIfNeeded(request);
      const refreshed = await this.#reviewCardStore.findReviewCardById(
        card.id,
        card.learningProfileId,
      );
      if (
        refreshed?.status === 'active' &&
        Date.parse(refreshed.schedule.dueAt) <= this.#clock.now.getTime()
      )
        eligible.push(refreshed);
    }
    eligible.sort(
      (left, right) =>
        Number(right.schedule.pendingCorrection) - Number(left.schedule.pendingCorrection) ||
        left.schedule.dueAt.localeCompare(right.schedule.dueAt) ||
        left.id.localeCompare(right.id),
    );
    const selected = eligible.slice(0, 5);
    const session = {
      cardIds: selected.map(({ id }) => id),
      createdAt: this.#clock.now.toISOString(),
      id: randomUUID(),
      learningProfileId: input.learningProfileId,
    };
    if (!(await this.#reviewCardStore.createShortReviewSession(session))) {
      throw new LearningProgressError('VERSION_CONFLICT', '短复习创建冲突，请重试');
    }
    return { ...session, cards: selected.map(viewCard) };
  }

  async getShortReviewSession(input: {
    learningProfileId: string;
    sessionId: string;
  }): Promise<ShortReviewSessionView> {
    const session = await this.#reviewCardStore.findShortReviewSession(
      input.sessionId,
      input.learningProfileId,
    );
    if (!session) throw new LearningProgressError('REVIEW_SESSION_NOT_FOUND', '没有找到这次短复习');
    const activeCards: StoredReviewCard[] = [];
    for (const id of session.cardIds) {
      const card = await this.#reviewCardStore.findReviewCardById(id, input.learningProfileId);
      if (!card || card.status !== 'active') continue;
      const request = await this.#requireRequest(card.requestId, input.learningProfileId);
      await this.#invalidateIfNeeded(request);
      const refreshed = await this.#reviewCardStore.findReviewCardById(
        card.id,
        input.learningProfileId,
      );
      if (refreshed?.status === 'active') activeCards.push(refreshed);
    }
    return {
      ...session,
      cardIds: activeCards.map(({ id }) => id),
      cards: activeCards.map(viewCard),
    };
  }

  async submitAttempt(input: {
    actor: AssessmentActorReference;
    cardId: string;
    hintLevel: 0 | 1 | 2;
    idempotencyKey: string;
    learningProfileId: string;
    perceivedDifficulty?: 'easy' | 'hard' | 'okay' | null;
    responseText: string;
    sessionId: string;
  }): Promise<{ attempt: ReviewCardAttempt; feedback: ReviewAttemptFeedback }> {
    const idempotencyKey = requiredText(input.idempotencyKey, '幂等键', 200);
    const session = await this.#reviewCardStore.findShortReviewSession(
      input.sessionId,
      input.learningProfileId,
    );
    if (!session || !session.cardIds.includes(input.cardId))
      throw new LearningProgressError('REVIEW_SESSION_NOT_FOUND', '复习卡不在这次短复习中');
    const card = await this.#reviewCardStore.findReviewCardById(
      input.cardId,
      input.learningProfileId,
    );
    if (!card) throw new LearningProgressError('REVIEW_CARD_NOT_FOUND', '没有找到这张复习卡');
    const request = await this.#requireRequest(card.requestId, input.learningProfileId);
    await this.#invalidateIfNeeded(request);
    const current = await this.#reviewCardStore.findReviewCardById(
      card.id,
      input.learningProfileId,
    );
    if (!current || current.status !== 'active')
      throw new LearningProgressError('REVIEW_CARD_NOT_READY', '复习卡来源已变化，正在安全重建');
    if (![0, 1, 2].includes(input.hintLevel))
      throw new LearningProgressError('INPUT_INVALID', '提示层级无效');
    const responseText = requiredText(input.responseText, '复习作答');
    const perceivedDifficulty = input.perceivedDifficulty ?? null;
    const existing = await this.#reviewCardStore.findReviewAttemptByIdempotencyKey(
      input.cardId,
      idempotencyKey,
      input.learningProfileId,
    );
    if (existing) {
      if (
        existing.sessionId !== session.id ||
        existing.hintLevel !== input.hintLevel ||
        existing.responseText !== responseText ||
        existing.perceivedDifficulty !== perceivedDifficulty
      ) {
        throw new LearningProgressError('INPUT_INVALID', '同一幂等键不能用于不同的复习作答');
      }
      return {
        attempt: existing,
        feedback: await this.#feedback(existing, input.learningProfileId),
      };
    }
    const outcome = ruleAccepts(current.candidate.gradingRule, responseText)
      ? 'correct'
      : 'incorrect';
    const nextIndex =
      outcome === 'incorrect' || input.hintLevel === 2
        ? 0
        : input.hintLevel === 0
          ? Math.min(4, current.schedule.stepIndex + 1)
          : current.schedule.stepIndex;
    const intervalDays = INTERVAL_DAYS[nextIndex]!;
    const scheduleAfter: ReviewCardSchedule = {
      dueAt: addDays(this.#clock.now, intervalDays),
      intervalDays,
      pendingCorrection: outcome === 'incorrect',
      stepIndex: nextIndex as 0 | 1 | 2 | 3 | 4,
    };
    const attempt: ReviewCardAttempt = {
      cardId: current.id,
      createdAt: this.#clock.now.toISOString(),
      hintLevel: input.hintLevel,
      id: randomUUID(),
      idempotencyKey,
      outcome,
      perceivedDifficulty,
      responseText,
      scheduleAfter,
      scheduleBefore: structuredClone(current.schedule),
      sessionId: session.id,
    };
    if (
      !(await this.#reviewCardStore.recordReviewAttempt({
        attempt,
        expectedSchedule: current.schedule,
        learningProfileId: input.learningProfileId,
      }))
    ) {
      throw new LearningProgressError('VERSION_CONFLICT', '复习进度已更新，请刷新后重试');
    }
    return { attempt, feedback: await this.#feedback(attempt, input.learningProfileId) };
  }

  async #feedback(
    attempt: ReviewCardAttempt,
    learningProfileId: string,
  ): Promise<ReviewAttemptFeedback> {
    const card = await this.#reviewCardStore.findReviewCardById(attempt.cardId, learningProfileId);
    if (!card) throw new LearningProgressError('REVIEW_CARD_NOT_FOUND', '没有找到这张复习卡');
    return {
      answer: card.candidate.expectedAnswer,
      currentState: attempt.outcome === 'incorrect' ? 'pending_correction' : 'scheduled',
      evidenceQualification:
        attempt.outcome === 'incorrect'
          ? 'correction_required'
          : attempt.hintLevel === 0
            ? 'independent'
            : 'assisted',
      explanationSteps: [...card.candidate.explanationSteps],
      hintImpact:
        attempt.hintLevel === 0
          ? '本次未使用提示，可作为独立复习证据。'
          : attempt.hintLevel === 1
            ? '本次使用了定位提示，记录为辅助复习证据。'
            : '本次使用了方法提示，次日重新安排无提示变式。',
      nextAction:
        attempt.outcome === 'incorrect'
          ? '先完成订正，再从次日无提示复习重新开始。'
          : attempt.scheduleAfter.intervalDays === 1
            ? '下一次复习安排在明天。'
            : `下一次复习安排在 ${attempt.scheduleAfter.intervalDays} 天后。`,
      nextDueAt: attempt.scheduleAfter.dueAt,
      nextIntervalDays: attempt.scheduleAfter.intervalDays,
      outcome: attempt.outcome,
    };
  }

  async #viewRequest(request: StoredReviewCardRequest): Promise<ReviewCardRequestView> {
    const card = request.currentCardId
      ? await this.#reviewCardStore.findReviewCardById(
          request.currentCardId,
          request.learningProfileId,
        )
      : null;
    return {
      aiDisclosure: AI_DISCLOSURE,
      card: card?.status === 'active' ? viewCard(card) : null,
      createdAt: request.createdAt,
      id: request.id,
      learningProfileId: request.learningProfileId,
      rebuildPending: request.rebuildPending,
      status: request.status,
      unavailableReason: request.unavailableReason,
      updatedAt: request.updatedAt,
    };
  }

  async #requireEligibleWrongItem(
    id: string,
    learningProfileId: string,
    actor: AssessmentActorReference,
  ): Promise<StoredWrongItem> {
    const item = await this.#wrongItemStore.findById(
      requiredText(id, '错题', 200),
      requiredText(learningProfileId, '学习档案', 200),
    );
    if (!item) throw new LearningProgressError('WRONG_ITEM_NOT_FOUND', '没有找到这道错题');
    const current = await this.#assessmentReader.getAcceptedObjectiveAssessmentSnapshot({
      actor,
      assessmentId: item.assessment.assessmentId,
      learningProfileId,
    });
    if (
      current.outcome !== 'incorrect' ||
      current.assessmentVersionId !== item.assessment.assessmentVersionId ||
      current.basis.sourceVersionId !== item.assessment.basis.sourceVersionId ||
      current.basis.selectionVersion !== item.assessment.basis.selectionVersion ||
      current.basis.validityEpoch !== item.assessment.basis.validityEpoch ||
      current.basis.contentHash !== item.assessment.basis.contentHash ||
      current.basis.kind !== item.assessment.basis.kind ||
      current.basis.versionLabel !== item.assessment.basis.versionLabel ||
      current.question.versionId !== item.assessment.question.versionId ||
      current.question.contentHash !== item.assessment.question.contentHash ||
      current.response.versionId !== item.assessment.response.versionId ||
      current.response.contentHash !== item.assessment.response.contentHash ||
      current.correctBasis.gradingRuleVersionId !==
        item.assessment.correctBasis.gradingRuleVersionId ||
      current.correctBasis.expectedDisplay !== item.assessment.correctBasis.expectedDisplay
    ) {
      throw new LearningProgressError('SOURCE_INELIGIBLE', '错题依赖的批改结果已经变化');
    }
    return item;
  }

  async #isSourceCurrent(request: StoredReviewCardRequest): Promise<boolean> {
    try {
      const item = await this.#requireEligibleWrongItem(
        request.source.wrongItemId,
        request.learningProfileId,
        request.actor,
      );
      return (
        item.stateRevision === request.source.wrongItemStateRevision &&
        item.classification.revision === request.source.classificationRevision &&
        item.themeId === request.source.themeId
      );
    } catch {
      return false;
    }
  }

  async #invalidateIfNeeded(request: StoredReviewCardRequest): Promise<void> {
    if (request.status !== 'ready') return;
    let reason: Parameters<ReviewCardStore['invalidateReviewCard']>[0]['reason'] | null = null;
    if (!(await this.#isSourceCurrent(request))) reason = 'SOURCE_CHANGED';
    else if (
      !(await this.#publicationGate.authorize({
        ageBand: request.source.ageBand,
        consentRevision: request.source.consentRevision,
        familySpaceId: request.familySpaceId,
        learningProfileId: request.learningProfileId,
      }))
    )
      reason = 'CONSENT_WITHDRAWN';
    else {
      const revalidation = await this.#qualityControl.revalidateAuthorization({
        decisionId: request.authorization.decisionId,
        expectedContainmentEpoch: request.authorization.containmentEpoch,
        phase: 'before_send',
        route: 'primary',
      });
      if (revalidation.status !== 'authorized')
        reason =
          revalidation.reason === 'CAPABILITY_CONTAINED'
            ? 'CAPABILITY_CONTAINED'
            : 'CAPABILITY_UNAVAILABLE';
    }
    if (reason)
      await this.#reviewCardStore.invalidateReviewCard({
        expectedStateRevision: request.stateRevision,
        learningProfileId: request.learningProfileId,
        reason,
        requestId: request.id,
        updatedAt: this.#clock.now.toISOString(),
      });
  }

  #modelRun(
    request: StoredReviewCardRequest,
    attempt: number,
    succeeded: boolean,
    result: Awaited<ReturnType<ReviewCardModelGatewayPort['runStructured']>> | null,
  ): ReviewCardModelRun {
    return {
      attempt,
      authorizationDecisionId: request.authorization.decisionId,
      capabilityVersionId: request.capability?.id ?? '',
      externalTraceId: result?.externalTraceId ?? null,
      finishedAt: this.#clock.now.toISOString(),
      inputTokens: result?.inputTokens ?? null,
      observedProvider: result?.provider ?? null,
      outputTokens: result?.outputTokens ?? null,
      succeeded,
    };
  }

  async #fail(
    request: StoredReviewCardRequest,
    reason: ReviewCardUnavailableReason,
    checks: ReviewCardCheck[],
    modelRuns: ReviewCardModelRun[],
  ): Promise<void> {
    await this.#reviewCardStore.failReviewCardRequest({
      expectedStateRevision: request.stateRevision,
      latestChecks: checks,
      learningProfileId: request.learningProfileId,
      modelRuns,
      reason,
      requestId: request.id,
      updatedAt: this.#clock.now.toISOString(),
    });
  }

  async #requireRequest(id: string, learningProfileId: string): Promise<StoredReviewCardRequest> {
    const request = await this.#reviewCardStore.findReviewCardRequestById(
      requiredText(id, '复习卡请求', 200),
      requiredText(learningProfileId, '学习档案', 200),
    );
    if (!request) throw new LearningProgressError('REVIEW_CARD_NOT_FOUND', '没有找到复习卡请求');
    return request;
  }
}
