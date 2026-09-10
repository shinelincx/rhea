import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AuthorizationDecision,
  AuthorizationPhase,
  CapabilityUseSlice,
  DegradedReason,
} from '@rhea/quality-control';

import { GeneratedLearningError } from './error.js';
import { hasPrematureAnswerLeakage, verifyDeterministicContent } from './quality.js';
import { generatedLearningSourceKey, stableGeneratedLearningHash } from './source-key.js';
import type {
  CurrentGenerationBasisReader,
  GenerationPublicationGate,
  GenerationQualityControlPort,
  ModelGatewayPort,
} from './ports.js';
import type { GeneratedLearningStore } from './store.js';
import type {
  GeneratedLearningCapability,
  GeneratedLearningContentVersion,
  GeneratedLearningPackCandidate,
  GeneratedLearningRequestView,
  GeneratedObjectiveRule,
  GenerationCheck,
  GenerationSourceSnapshot,
  GenerationUnavailableReason,
  ModelRunRecord,
  ModelTask,
  ModelTaskResult,
  StoredGenerationRequest,
} from './types.js';

const MAX_GENERATION_ATTEMPTS = 2;
const PROCESSING_LEASE_MS = 60_000;
const AI_DISCLOSURE = '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。' as const;

export interface GeneratedLearningServiceDependencies {
  basisReader: CurrentGenerationBasisReader;
  clock?: { readonly now: Date };
  modelGateway: ModelGatewayPort;
  publicationGate: GenerationPublicationGate;
  qualityControl: GenerationQualityControlPort;
  store: GeneratedLearningStore;
}

function requiredText(value: string, field: string, maxLength = 500): string {
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new GeneratedLearningError('INPUT_INVALID', `${field}不能为空且不能超过 ${maxLength} 字`);
  }
  return text;
}

function hash(value: unknown): string {
  return stableGeneratedLearningHash(value);
}

function modelRun(
  request: StoredGenerationRequest,
  capability: GeneratedLearningCapability,
  attempt: number,
  succeeded: boolean,
  result: ModelTaskResult | null,
  finishedAt: string,
): ModelRunRecord {
  return {
    attempt,
    authorizationDecisionId: request.authorization.decisionId,
    capabilityVersionId: capability.id,
    externalTraceId: result?.externalTraceId ?? null,
    finishedAt,
    inputTokens: result?.inputTokens ?? null,
    modelOrEngineVersion: capability.modelOrEngine.version,
    observedProvider: result?.provider ?? null,
    outputTokens: result?.outputTokens ?? null,
    promptOrConfigVersion: capability.promptOrConfig.version,
    provider: capability.provider.id,
    providerVersion: capability.provider.version,
    succeeded,
  };
}

function capabilityUseSlice(source: GenerationSourceSnapshot): CapabilityUseSlice {
  return {
    basisState: source.basisHasConflict ? 'conflicted' : 'current',
    gradeBand: source.ageBand,
    imageQuality: 'not_applicable',
    questionType: 'process',
    riskLevel: 'medium',
    subject: source.subject,
  };
}

function authorizationSnapshot(decision: AuthorizationDecision) {
  return {
    containmentEpoch: decision.containmentEpoch,
    degradedReason: decision.degradedReason,
    decisionId: decision.decisionId,
    issuedAt: decision.issuedAt,
  };
}

function authorizedCapability(
  decision: AuthorizationDecision,
  expectedSlice: CapabilityUseSlice,
): GeneratedLearningCapability | null {
  if (
    decision.scope.capabilityKey !== 'ai.generated-learning' ||
    decision.scope.kind !== 'ai' ||
    !isDeepStrictEqual(decision.scope.slice, expectedSlice) ||
    !Number.isInteger(decision.containmentEpoch) ||
    decision.containmentEpoch < 0 ||
    !decision.decisionId.trim() ||
    Number.isNaN(Date.parse(decision.issuedAt))
  ) {
    throw new GeneratedLearningError('CAPABILITY_UNAVAILABLE', '能力授权决策无效');
  }
  if (decision.status !== 'authorized') {
    if (!decision.degradedReason || decision.primary) {
      throw new GeneratedLearningError('CAPABILITY_UNAVAILABLE', '降级决策缺少明确原因');
    }
    return null;
  }
  const capability = decision.primary?.capabilityVersion;
  if (
    !capability ||
    decision.degradedReason !== null ||
    capability.kind !== 'ai' ||
    capability.capabilityKey !== 'ai.generated-learning' ||
    capability.promptOrConfig.kind !== 'prompt'
  ) {
    throw new GeneratedLearningError('CAPABILITY_UNAVAILABLE', '能力授权版本无效');
  }
  return structuredClone(capability);
}

function basisMatches(
  left: GenerationSourceSnapshot['basis'],
  right: GenerationSourceSnapshot['basis'],
): boolean {
  return (
    left.materialId === right.materialId &&
    left.sourceVersionId === right.sourceVersionId &&
    left.selectionVersion === right.selectionVersion &&
    left.validityEpoch === right.validityEpoch &&
    left.contentHash === right.contentHash &&
    left.kind === right.kind &&
    left.versionLabel === right.versionLabel
  );
}

function sanitizeSourceText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已移除]')
    .replace(/(?<!\d)1[3-9](?:[\s-]?\d){9}(?!\d)/g, '[手机号已移除]')
    .replace(/(?<!\d)\d{6}[\s-]?\d{8}[\s-]?\d{3}[\dXx](?!\d)/g, '[身份证号已移除]')
    .replace(/学生\s*[\p{Script=Han}]{1,6}(?=\s*(?:同学|就读|在|，|,|。))/gu, '学生[姓名已移除]')
    .replace(/[\p{Script=Han}]{2,20}(?:小学|学校|中学)/gu, '[学校已移除]')
    .replace(/((?:学号|账号|帐号|考号)\s*[:：]?\s*)[A-Z0-9_-]{4,32}/gi, '$1[已移除]')
    .replace(/((?:姓名|学校|班级|地址|住址)\s*[:：])\s*[^\s，,。；;\n]{1,30}/g, '$1[已移除]')
    .trim();
}

function taskFor(request: StoredGenerationRequest): ModelTask {
  if (!request.capability) {
    throw new GeneratedLearningError('CAPABILITY_UNAVAILABLE', '当前没有可用的生成能力');
  }
  return {
    ageBand: request.source.ageBand,
    capability: structuredClone(request.capability),
    hintPolicy: 'orientation_then_method_then_full_explanation',
    maxQuizItems: 5,
    purpose: 'learning_pack',
    riskLevel: 'medium',
    sourceBasis: {
      kind: request.source.basis.kind,
    },
    subject: request.source.subject,
    untrustedSourceExcerpts: request.source.excerpts.map((excerpt, index) => ({
      kind: excerpt.kind,
      sourceRef: `source-${index + 1}`,
      text: sanitizeSourceText(excerpt.text),
    })),
  };
}

function normalizeCandidateReferences(
  candidateValue: unknown,
  source: GenerationSourceSnapshot,
): unknown {
  if (!isCandidate(candidateValue)) return candidateValue;
  const candidate = structuredClone(candidateValue);
  const regionByProviderRef = new Map(
    source.excerpts.map(({ regionId }, index) => [`source-${index + 1}`, regionId]),
  );
  candidate.keyTerms = candidate.keyTerms.map(({ sourceRegionIds, term }) => ({
    sourceRegionIds: sourceRegionIds.map(
      (sourceRef) => regionByProviderRef.get(sourceRef) ?? `unresolved:${sourceRef}`,
    ),
    term,
  }));
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum;
}

function isTextArray(
  value: unknown,
  minimum = 0,
  maximum = 10,
  maximumItemLength = 500,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((item) => isBoundedText(item, maximumItemLength))
  );
}

function isRule(value: unknown): value is GeneratedObjectiveRule {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'numeric') return isBoundedText(value.expected, 200);
  if (value.kind === 'single_choice') return isBoundedText(value.correctOption, 200);
  return (
    value.kind === 'accepted_text' &&
    isTextArray(value.acceptedAnswers, 1, 10, 500) &&
    typeof value.caseSensitive === 'boolean' &&
    typeof value.collapseWhitespace === 'boolean'
  );
}

function isQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedText(value.id, 200) &&
    isBoundedText(value.question, 1_000) &&
    isBoundedText(value.expectedAnswer, 500) &&
    isTextArray(value.explanationSteps, 1, 8, 500) &&
    isRule(value.gradingRule)
  );
}

function isCandidate(value: unknown): value is GeneratedLearningPackCandidate {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.fullExplanation)) {
    return false;
  }
  return (
    isBoundedText(value.summary.title, 300) &&
    isTextArray(value.summary.keyPoints, 1, 6, 500) &&
    isBoundedText(value.orientationHint, 500) &&
    isBoundedText(value.methodHint, 500) &&
    isBoundedText(value.fullExplanation.answer, 500) &&
    isTextArray(value.fullExplanation.steps, 1, 8, 500) &&
    Array.isArray(value.keyTerms) &&
    value.keyTerms.length > 0 &&
    value.keyTerms.every(
      (term) =>
        isRecord(term) &&
        isBoundedText(term.term, 200) &&
        isTextArray(term.sourceRegionIds, 1, 10, 200),
    ) &&
    isTextArray(value.supplementalNotes, 0, 5, 500) &&
    Array.isArray(value.variations) &&
    value.variations.length > 0 &&
    value.variations.length <= 3 &&
    value.variations.every(isQuestion) &&
    Array.isArray(value.quiz) &&
    value.quiz.length > 0 &&
    value.quiz.length <= 5 &&
    value.quiz.every(isQuestion) &&
    new Set(
      [...value.variations, ...value.quiz].map((question) =>
        isRecord(question) ? question.id : undefined,
      ),
    ).size ===
      value.variations.length + value.quiz.length
  );
}

function canonicalDecimal(value: string): string | null {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? String(number) : null;
}

function ruleAccepts(rule: GeneratedObjectiveRule, answer: string): boolean {
  if (rule.kind === 'numeric') {
    const expected = canonicalDecimal(rule.expected);
    return expected !== null && canonicalDecimal(answer) === expected;
  }
  if (rule.kind === 'single_choice') {
    return rule.correctOption.trim().toLocaleUpperCase() === answer.trim().toLocaleUpperCase();
  }
  const normalize = (value: string) => {
    const whitespace = rule.collapseWhitespace ? value.trim().replace(/\s+/g, ' ') : value.trim();
    return rule.caseSensitive ? whitespace : whitespace.toLocaleLowerCase();
  };
  return rule.acceptedAnswers.some((candidate) => normalize(candidate) === normalize(answer));
}

function check(kind: GenerationCheck['kind'], passed: boolean, detail: string): GenerationCheck {
  return { detail, kind, passed };
}

function generationChecks(
  candidateValue: unknown,
  source: GenerationSourceSnapshot,
): GenerationCheck[] {
  const schemaPassed = isCandidate(candidateValue);
  if (!schemaPassed) {
    return [
      check('schema', false, '结构化输出缺少必填内容或超过题包数量限制'),
      check('source_coverage', false, '结构无效，无法验证来源覆盖'),
      check('consistency', false, '结构无效，无法验证答案一致性'),
      check('solvability', false, '结构无效，无法验证可解性'),
      check('age_appropriateness', false, '结构无效，无法验证年龄适配'),
      check('answer_leakage', false, '结构无效，无法验证提示泄露'),
      check('safety', false, '结构无效，无法验证内容安全'),
    ];
  }
  const candidate = candidateValue;
  const regionIds = new Set(source.excerpts.map(({ regionId }) => regionId));
  const sourceCoverage = candidate.keyTerms.every(
    ({ sourceRegionIds }) =>
      sourceRegionIds.length > 0 && sourceRegionIds.every((id) => regionIds.has(id)),
  );
  const questions = [...candidate.variations, ...candidate.quiz];
  const consistency = questions.every(({ expectedAnswer, gradingRule }) =>
    ruleAccepts(gradingRule, expectedAnswer),
  );
  const deterministicVerification = verifyDeterministicContent(candidate, source);
  const originalQuestions = new Set(
    source.excerpts
      .filter(({ kind }) => kind === 'question')
      .map(({ text }) => text.trim().toLocaleLowerCase()),
  );
  const solvability = questions.every(
    ({ explanationSteps, question }) =>
      explanationSteps.length > 0 && !originalQuestions.has(question.trim().toLocaleLowerCase()),
  );
  const maximumLength =
    source.ageBand === 'lower_primary' ? 72 : source.ageBand === 'middle_primary' ? 96 : 120;
  const learnerText = [
    candidate.summary.title,
    ...candidate.summary.keyPoints,
    ...candidate.keyTerms.map(({ term }) => term),
    ...candidate.supplementalNotes,
    candidate.orientationHint,
    candidate.methodHint,
    candidate.fullExplanation.answer,
    ...candidate.fullExplanation.steps,
    ...questions.flatMap(({ expectedAnswer, explanationSteps, question }) => [
      question,
      expectedAnswer,
      ...explanationSteps,
    ]),
  ];
  const maximumSteps =
    source.ageBand === 'lower_primary' ? 4 : source.ageBand === 'middle_primary' ? 6 : 8;
  const ageAppropriate =
    learnerText.every((text) => text.trim().length <= maximumLength) &&
    candidate.fullExplanation.steps.length <= maximumSteps &&
    questions.every(({ explanationSteps }) => explanationSteps.length <= maximumSteps);
  const answerLeakage = !hasPrematureAnswerLeakage(candidate);
  const allOutput = JSON.stringify(candidate);
  const safe = !/(不要告诉|替我保密|你真笨|危险挑战|透露.*(?:姓名|学校|电话))/i.test(allOutput);
  return [
    check('schema', true, '结构和数量符合学习题包约束'),
    check('source_coverage', sourceCoverage, '关键术语必须引用已确认内容片段'),
    check(
      'consistency',
      consistency && deterministicVerification !== 'failed',
      '题目答案必须与评分规则及可确定验证的算式一致',
    ),
    check('solvability', solvability, '变式必须可解且不能复制原题'),
    check('age_appropriateness', ageAppropriate, '句长和步骤深度必须适合年龄层级'),
    check('answer_leakage', answerLeakage, '前两级提示不能提前暴露完整答案'),
    check('safety', safe, '内容不能包含依赖、羞辱、危险挑战或索取个人信息'),
  ];
}

function requestFingerprint(input: {
  capability: GeneratedLearningCapability | null;
  familySpaceId: string;
  learningProfileId: string;
  materialId: string;
  source: GenerationSourceSnapshot;
}): string {
  return hash({
    capability: input.capability,
    familySpaceId: input.familySpaceId,
    learningProfileId: input.learningProfileId,
    materialId: input.materialId,
    source: input.source,
  });
}

function unavailableView(
  request: StoredGenerationRequest,
  reason: GenerationUnavailableReason,
): GeneratedLearningRequestView {
  return view(request, { reason });
}

function degradedReason(
  request: StoredGenerationRequest,
  override?: GenerationUnavailableReason,
): DegradedReason | null {
  if (override === 'CAPABILITY_CONTAINED') return 'CAPABILITY_CONTAINED';
  if (override === 'CAPABILITY_UNAVAILABLE') {
    return request.authorization.degradedReason ?? 'NO_APPLICABLE_CAPABILITY';
  }
  return request.authorization.degradedReason;
}

function view(
  request: StoredGenerationRequest,
  override?: { reason: GenerationUnavailableReason },
): GeneratedLearningRequestView {
  const version = override
    ? null
    : (request.versions.find(({ id }) => id === request.currentVersionId) ?? null);
  const isReady = request.status === 'ready' && version !== null;
  const level = request.revealedHintLevel;
  const unavailableReason = override?.reason ?? request.unavailableReason;
  const capabilityDegradedReason = degradedReason(request, override?.reason);
  return {
    aiDisclosure: AI_DISCLOSURE,
    authorizationDecision: {
      containmentEpoch: request.authorization.containmentEpoch,
      id: request.authorization.decisionId,
      issuedAt: request.authorization.issuedAt,
    },
    capabilityVersion: request.capability ? structuredClone(request.capability) : null,
    contentState: override
      ? 'unavailable'
      : (version?.contentState ??
        (request.status === 'unavailable' || request.status === 'canceled'
          ? 'unavailable'
          : 'unavailable')),
    createdAt: request.createdAt,
    degraded: capabilityDegradedReason
      ? { nextAction: 'retry_later', reason: capabilityDegradedReason, retryable: true }
      : null,
    familySpaceId: request.familySpaceId,
    generatedContent: isReady
      ? {
          fullExplanation: level >= 3 ? structuredClone(version.pack.fullExplanation) : null,
          keyTerms: structuredClone(version.pack.keyTerms),
          methodHint: level >= 2 ? version.pack.methodHint : null,
          orientationHint: level >= 1 ? version.pack.orientationHint : null,
          quiz: version.pack.quiz.map(({ id, question }) => ({ id, question })),
          summary: structuredClone(version.pack.summary),
          supplementalNotes: structuredClone(version.pack.supplementalNotes),
          variations: version.pack.variations.map(({ id, question }) => ({ id, question })),
        }
      : null,
    id: request.id,
    learningProfileId: request.learningProfileId,
    materialId: request.materialId,
    purpose: request.purpose,
    revealedHintLevel: level,
    sourceVersion: {
      basisSelectionVersion: request.source.basis.selectionVersion,
      basisSourceVersionId: request.source.basis.sourceVersionId,
      basisValidityEpoch: request.source.basis.validityEpoch,
      classificationRevision: request.source.classificationRevision,
      confirmedContentVersionId: request.source.confirmedContentVersionId,
      versionLabel: request.source.basis.versionLabel,
    },
    status: override ? 'unavailable' : request.status,
    unavailableReason,
    updatedAt: request.updatedAt,
  };
}

export class GeneratedLearningService {
  readonly #basisReader: CurrentGenerationBasisReader;
  readonly #clock: { readonly now: Date };
  readonly #modelGateway: ModelGatewayPort;
  readonly #publicationGate: GenerationPublicationGate;
  readonly #qualityControl: GenerationQualityControlPort;
  readonly #store: GeneratedLearningStore;

  constructor(dependencies: GeneratedLearningServiceDependencies) {
    this.#basisReader = dependencies.basisReader;
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
    this.#store = dependencies.store;
  }

  async requestContent(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    consentRevision: number;
    familySpaceId: string;
    idempotencyKey: string;
    learningProfileId: string;
    materialId: string;
    source: GenerationSourceSnapshot;
  }): Promise<GeneratedLearningRequestView> {
    const idempotencyKey = requiredText(input.idempotencyKey, '幂等键', 200);
    if (
      input.source.basis.materialId !== input.materialId ||
      input.source.confirmedContentVersionId.trim().length === 0 ||
      input.source.excerpts.length === 0 ||
      !Number.isInteger(input.consentRevision) ||
      input.consentRevision < 1
    ) {
      throw new GeneratedLearningError('INPUT_INVALID', '学习依据快照与生成请求不一致');
    }
    const useSlice = capabilityUseSlice(input.source);
    const decision = await this.#qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: input.familySpaceId,
      kind: 'ai',
      slice: useSlice,
    });
    const capability = authorizedCapability(decision, useSlice);
    const fingerprint = requestFingerprint({
      capability,
      familySpaceId: input.familySpaceId,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      source: input.source,
    });
    const existing = await this.#store.findByIdempotencyKey(
      idempotencyKey,
      input.learningProfileId,
    );
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new GeneratedLearningError('INPUT_INVALID', '同一幂等键不能用于不同的生成请求');
      }
      return this.#freshView(existing);
    }
    const createdAt = this.#clock.now.toISOString();
    const unavailableReason = input.source.basisHasConflict
      ? ('SOURCE_UNAVAILABLE' as const)
      : capability
        ? null
        : ('CAPABILITY_UNAVAILABLE' as const);
    const request: StoredGenerationRequest = {
      actor: { ...input.actor },
      authorization: authorizationSnapshot(decision),
      capability,
      consentRevision: input.consentRevision,
      createdAt,
      currentVersionId: null,
      familySpaceId: requiredText(input.familySpaceId, '家庭空间', 200),
      id: randomUUID(),
      idempotencyKey,
      latestChecks: [],
      learningProfileId: requiredText(input.learningProfileId, '学习档案', 200),
      materialId: requiredText(input.materialId, '学习资料', 200),
      modelRuns: [],
      processingLeaseExpiresAt: null,
      purpose: 'learning_pack',
      requestFingerprint: fingerprint,
      revealedHintLevel: 0,
      source: structuredClone(input.source),
      stateRevision: 0,
      status: unavailableReason ? 'unavailable' : 'queued',
      unavailableReason,
      updatedAt: createdAt,
      versions: [],
    };
    if (!(await this.#store.create(request))) {
      const concurrent = await this.#store.findByIdempotencyKey(
        idempotencyKey,
        input.learningProfileId,
      );
      if (concurrent?.requestFingerprint === fingerprint) return this.#freshView(concurrent);
      throw new GeneratedLearningError('VERSION_CONFLICT', '生成请求状态已变化，请刷新后重试');
    }
    return view(request);
  }

  async processRequest(input: {
    learningProfileId: string;
    requestId: string;
  }): Promise<GeneratedLearningRequestView> {
    let request = await this.#requireRequest(input.requestId, input.learningProfileId);
    if (['canceled', 'ready', 'unavailable'].includes(request.status)) {
      return this.#freshView(request);
    }
    const claimedAt = this.#clock.now;
    const claimed = await this.#store.markGenerating({
      expectedStateRevision: request.stateRevision,
      leaseExpiresAt: new Date(claimedAt.getTime() + PROCESSING_LEASE_MS).toISOString(),
      learningProfileId: request.learningProfileId,
      now: claimedAt.toISOString(),
      requestId: request.id,
      updatedAt: claimedAt.toISOString(),
    });
    if (!claimed) {
      request = await this.#requireRequest(input.requestId, input.learningProfileId);
      return this.#freshView(request);
    }
    request.stateRevision += 1;
    request.status = 'generating';
    const expectedStateRevision = request.stateRevision;

    if (!request.capability) {
      return this.#fail(request, expectedStateRevision, 'CAPABILITY_UNAVAILABLE', [], []);
    }
    const capability = request.capability;
    if (!(await this.#consentCanPublish(request))) {
      return this.#fail(request, expectedStateRevision, 'CONSENT_WITHDRAWN', [], []);
    }
    if (!(await this.#sourceIsCurrent(request))) {
      return this.#fail(request, expectedStateRevision, 'SOURCE_CHANGED', [], []);
    }

    const modelRuns: ModelRunRecord[] = [];
    let latestChecks: GenerationCheck[] = [];
    let candidate: GeneratedLearningPackCandidate | null = null;
    let hadCandidate = false;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const beforeSendRejection = await this.#capabilityRejection(request, 'before_send');
      if (beforeSendRejection) {
        return this.#fail(
          request,
          expectedStateRevision,
          beforeSendRejection,
          latestChecks,
          modelRuns,
        );
      }
      let result: ModelTaskResult;
      try {
        result = await this.#modelGateway.runStructured(taskFor(request));
      } catch {
        modelRuns.push(
          modelRun(request, capability, attempt, false, null, this.#clock.now.toISOString()),
        );
        continue;
      }
      if (result.provider !== capability.provider.id) {
        modelRuns.push(
          modelRun(request, capability, attempt, false, result, this.#clock.now.toISOString()),
        );
        continue;
      }
      try {
        candidate = normalizeCandidateReferences(
          result.candidate,
          request.source,
        ) as GeneratedLearningPackCandidate;
        hadCandidate = true;
        latestChecks = generationChecks(candidate, request.source);
      } catch {
        modelRuns.push(
          modelRun(request, capability, attempt, false, result, this.#clock.now.toISOString()),
        );
        continue;
      }
      modelRuns.push(
        modelRun(request, capability, attempt, true, result, this.#clock.now.toISOString()),
      );
      let afterReceiveRejection: 'CAPABILITY_CONTAINED' | 'CAPABILITY_UNAVAILABLE' | null;
      try {
        afterReceiveRejection = await this.#capabilityRejection(request, 'after_receive');
      } catch {
        return this.#fail(request, expectedStateRevision, 'CAPABILITY_UNAVAILABLE', [], modelRuns);
      }
      if (afterReceiveRejection) {
        return this.#fail(request, expectedStateRevision, afterReceiveRejection, [], modelRuns);
      }
      if (latestChecks.every(({ passed }) => passed)) break;
      candidate = null;
    }
    if (!candidate) {
      return this.#fail(
        request,
        expectedStateRevision,
        hadCandidate ? 'GENERATION_CHECK_FAILED' : 'MODEL_UNAVAILABLE',
        latestChecks,
        modelRuns,
      );
    }
    if (!(await this.#consentCanPublish(request))) {
      return this.#fail(
        request,
        expectedStateRevision,
        'CONSENT_WITHDRAWN',
        latestChecks,
        modelRuns,
      );
    }
    if (!(await this.#sourceIsCurrent(request))) {
      return this.#fail(request, expectedStateRevision, 'SOURCE_CHANGED', latestChecks, modelRuns);
    }
    const publicationRejection = await this.#capabilityRejection(request, 'before_publish');
    if (publicationRejection) {
      return this.#fail(
        request,
        expectedStateRevision,
        publicationRejection,
        latestChecks,
        modelRuns,
      );
    }
    const predecessor = await this.#store.findLatestReadyForSource(
      generatedLearningSourceKey(request.source),
      request.learningProfileId,
    );
    const predecessorVersion = predecessor?.versions.find(
      ({ id }) => id === predecessor.currentVersionId,
    );
    const createdAt = this.#clock.now.toISOString();
    const version: GeneratedLearningContentVersion = {
      authorization: structuredClone(request.authorization),
      capability: structuredClone(request.capability),
      checks: structuredClone(latestChecks),
      contentState:
        candidate.supplementalNotes.length > 0 ||
        verifyDeterministicContent(candidate, request.source) !== 'verified'
          ? 'confirmation_recommended'
          : 'direct_learning',
      createdAt,
      id: randomUUID(),
      pack: structuredClone(candidate),
      predecessorId: predecessorVersion?.id ?? null,
      revision: (predecessorVersion?.revision ?? 0) + 1,
      source: structuredClone(request.source),
    };
    const completion = await this.#store.complete({
      expectedStateRevision,
      latestChecks,
      learningProfileId: request.learningProfileId,
      modelRuns,
      requestId: request.id,
      version,
    });
    if (completion === 'consent_withdrawn') {
      return this.#fail(
        request,
        expectedStateRevision,
        'CONSENT_WITHDRAWN',
        latestChecks,
        modelRuns,
      );
    }
    if (completion === 'source_changed') {
      return this.#fail(request, expectedStateRevision, 'SOURCE_CHANGED', latestChecks, modelRuns);
    }
    if (completion === 'capability_contained' || completion === 'capability_unavailable') {
      return this.#fail(
        request,
        expectedStateRevision,
        completion === 'capability_contained' ? 'CAPABILITY_CONTAINED' : 'CAPABILITY_UNAVAILABLE',
        latestChecks,
        modelRuns,
      );
    }
    if (completion === 'conflict') {
      return this.#freshView(await this.#requireRequest(request.id, request.learningProfileId));
    }
    request.currentVersionId = version.id;
    request.latestChecks = latestChecks;
    request.modelRuns.push(...modelRuns);
    request.stateRevision += 1;
    request.status = 'ready';
    request.updatedAt = createdAt;
    request.versions.push(version);
    return view(request);
  }

  async getRequest(input: {
    learningProfileId: string;
    requestId: string;
  }): Promise<GeneratedLearningRequestView> {
    return this.#freshView(await this.#requireRequest(input.requestId, input.learningProfileId));
  }

  async revealNextHint(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    expectedLevel: 0 | 1 | 2 | 3;
    learningProfileId: string;
    requestId: string;
  }): Promise<GeneratedLearningRequestView> {
    const request = await this.#requireRequest(input.requestId, input.learningProfileId);
    const capabilityRejection = await this.#capabilityRejection(request, 'before_publish');
    if (
      request.status !== 'ready' ||
      !request.currentVersionId ||
      !(await this.#consentCanPublish(request)) ||
      !(await this.#sourceIsCurrent(request)) ||
      capabilityRejection
    ) {
      throw new GeneratedLearningError('GENERATION_NOT_READY', '当前内容暂不可展开，请重新生成');
    }
    if (request.revealedHintLevel > input.expectedLevel) return view(request);
    if (request.revealedHintLevel < input.expectedLevel) {
      throw new GeneratedLearningError('VERSION_CONFLICT', '提示状态已变化，请刷新后重试');
    }
    if (request.revealedHintLevel === 3) return view(request);
    const nextLevel = (request.revealedHintLevel + 1) as 1 | 2 | 3;
    const saved = await this.#store.recordHintUsage({
      actor: input.actor,
      expectedLevel: request.revealedHintLevel as 0 | 1 | 2,
      learningProfileId: request.learningProfileId,
      nextLevel,
      occurredAt: this.#clock.now.toISOString(),
      requestId: request.id,
      versionId: request.currentVersionId,
    });
    if (saved === 'consent_withdrawn') {
      return unavailableView(request, 'CONSENT_WITHDRAWN');
    }
    if (saved === 'source_changed') {
      return unavailableView(request, 'SOURCE_CHANGED');
    }
    if (saved === 'capability_contained' || saved === 'capability_unavailable') {
      return unavailableView(
        request,
        saved === 'capability_contained' ? 'CAPABILITY_CONTAINED' : 'CAPABILITY_UNAVAILABLE',
      );
    }
    if (saved === 'conflict') {
      const latest = await this.#requireRequest(request.id, request.learningProfileId);
      if (latest.revealedHintLevel > input.expectedLevel) return this.#freshView(latest);
      throw new GeneratedLearningError('VERSION_CONFLICT', '提示状态已变化，请刷新后重试');
    }
    request.revealedHintLevel = nextLevel;
    request.stateRevision += 1;
    return view(request);
  }

  async cancelRequest(input: {
    learningProfileId: string;
    requestId: string;
  }): Promise<GeneratedLearningRequestView> {
    const request = await this.#requireRequest(input.requestId, input.learningProfileId);
    if (!['queued', 'generating'].includes(request.status)) return this.#freshView(request);
    const updatedAt = this.#clock.now.toISOString();
    if (
      !(await this.#store.cancel({
        expectedStateRevision: request.stateRevision,
        learningProfileId: request.learningProfileId,
        reason: 'GENERATION_CANCELED',
        requestId: request.id,
        updatedAt,
      }))
    ) {
      throw new GeneratedLearningError('VERSION_CONFLICT', '生成请求状态已变化，请刷新后重试');
    }
    request.stateRevision += 1;
    request.status = 'canceled';
    request.unavailableReason = 'GENERATION_CANCELED';
    request.updatedAt = updatedAt;
    return view(request);
  }

  async #consentCanPublish(request: StoredGenerationRequest): Promise<boolean> {
    return this.#publicationGate.authorize({
      ageBand: request.source.ageBand,
      consentRevision: request.consentRevision,
      familySpaceId: request.familySpaceId,
      learningProfileId: request.learningProfileId,
    });
  }

  async #capabilityRejection(
    request: StoredGenerationRequest,
    phase: AuthorizationPhase,
  ): Promise<'CAPABILITY_CONTAINED' | 'CAPABILITY_UNAVAILABLE' | null> {
    if (!request.capability) return 'CAPABILITY_UNAVAILABLE';
    const result = await this.#qualityControl.revalidateAuthorization({
      decisionId: request.authorization.decisionId,
      expectedContainmentEpoch: request.authorization.containmentEpoch,
      phase,
      route: 'primary',
    });
    if (result.status === 'rejected') {
      return result.reason === 'CAPABILITY_CONTAINED'
        ? 'CAPABILITY_CONTAINED'
        : 'CAPABILITY_UNAVAILABLE';
    }
    return result.decisionId === request.authorization.decisionId &&
      isDeepStrictEqual(result.capabilityVersion, request.capability) &&
      result.containmentEpoch === request.authorization.containmentEpoch
      ? null
      : 'CAPABILITY_UNAVAILABLE';
  }

  async #fail(
    request: StoredGenerationRequest,
    expectedStateRevision: number,
    reason: GenerationUnavailableReason,
    latestChecks: GenerationCheck[],
    modelRuns: ModelRunRecord[],
  ): Promise<GeneratedLearningRequestView> {
    const updatedAt = this.#clock.now.toISOString();
    const failed = await this.#store.fail({
      expectedStateRevision,
      latestChecks,
      learningProfileId: request.learningProfileId,
      modelRuns,
      reason,
      requestId: request.id,
      updatedAt,
    });
    if (!failed) {
      return this.#freshView(await this.#requireRequest(request.id, request.learningProfileId));
    }
    request.latestChecks = latestChecks;
    request.modelRuns.push(...modelRuns);
    request.stateRevision += 1;
    request.status = 'unavailable';
    request.unavailableReason = reason;
    request.updatedAt = updatedAt;
    return view(request);
  }

  async #freshView(request: StoredGenerationRequest): Promise<GeneratedLearningRequestView> {
    if (request.status !== 'ready') return view(request);
    if (!(await this.#consentCanPublish(request))) {
      return unavailableView(request, 'CONSENT_WITHDRAWN');
    }
    if (!(await this.#sourceIsCurrent(request))) {
      return unavailableView(request, 'SOURCE_CHANGED');
    }
    const capabilityRejection = await this.#capabilityRejection(request, 'before_publish');
    return capabilityRejection ? unavailableView(request, capabilityRejection) : view(request);
  }

  async #sourceIsCurrent(request: StoredGenerationRequest): Promise<boolean> {
    try {
      const current = await this.#basisReader.getCurrentLearningContextReference({
        actor: request.actor,
        learningProfileId: request.learningProfileId,
        materialId: request.materialId,
      });
      return (
        basisMatches(request.source.basis, current.basis) &&
        request.source.classificationRevision === current.classificationRevision &&
        request.source.confirmedContentVersionId === current.confirmedContentVersionId &&
        request.source.coursePathName === current.coursePathName &&
        request.source.subject === current.subject &&
        request.source.unitName === current.unitName &&
        request.source.knowledgePointNames.length === current.knowledgePointNames.length &&
        request.source.knowledgePointNames.every(
          (name, index) => name === current.knowledgePointNames[index],
        )
      );
    } catch {
      return false;
    }
  }

  async #requireRequest(id: string, learningProfileId: string): Promise<StoredGenerationRequest> {
    const request = await this.#store.findById(
      requiredText(id, '生成请求', 200),
      requiredText(learningProfileId, '学习档案', 200),
    );
    if (!request) {
      throw new GeneratedLearningError('GENERATION_REQUEST_NOT_FOUND', '没有找到这次生成请求');
    }
    return request;
  }
}
