import { createHash, randomUUID } from 'node:crypto';

import type { AuthorizationDecision, CapabilityUseSlice } from '@rhea/quality-control';

import { AssessmentError } from './error.js';
import type {
  OpenAssessmentBasisReader,
  OpenAssessmentInputReader,
  OpenAssessmentModelGatewayPort,
  OpenAssessmentPublicationGate,
  OpenAssessmentQualityControlPort,
} from './suggested-assessment.ports.js';
import type { SuggestedAssessmentStore } from './suggested-assessment.store.js';
import type {
  AcceptedOpenAssessmentResult,
  OpenAssessmentAgeBand,
  OpenAssessmentModelCandidate,
  OpenAssessmentModelResult,
  OpenAssessmentTaskType,
  OpenAssessmentReviewDecision,
  OpenAssessmentReviewerReference,
  ResolvedOpenAssessmentInput,
  StoredSuggestedAssessment,
  SuggestedAssessmentAuthorizationSnapshot,
  SuggestedAssessmentUnavailableReason,
  SuggestedAssessmentView,
} from './suggested-assessment.types.js';
import type { AssessmentActorReference, ObjectiveAssessmentInputReference } from './types.js';

const DISCLOSURE = 'AI 建议评价，不是官方成绩；需由有权成年人复核后才形成批改结果。' as const;
const TASK_SUBJECT = {
  chinese_expression: 'chinese',
  english_expression: 'english',
  mathematics_process: 'mathematics',
  science_inquiry: 'science',
} as const;

export interface SuggestedAssessmentServiceDependencies {
  basisReader: OpenAssessmentBasisReader;
  clock?: { readonly now: Date };
  inputReader: OpenAssessmentInputReader;
  modelGateway: OpenAssessmentModelGatewayPort;
  publicationGate: OpenAssessmentPublicationGate;
  qualityControl: OpenAssessmentQualityControlPort;
  store: SuggestedAssessmentStore;
}

function requiredText(value: string, label: string, maximum = 4_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AssessmentError('INPUT_INVALID', `${label}不能为空且不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function contentHash(kind: 'question' | 'response', versionId: string, text: string): string {
  return createHash('sha256').update(`${kind}\u001f${versionId}\u001f${text}`).digest('hex');
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sanitizeModelText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已移除]')
    .replace(/(?<!\d)1[3-9](?:[\s-]?\d){9}(?!\d)/g, '[手机号已移除]')
    .replace(/(?<!\d)\d{6}[\s-]?\d{8}[\s-]?\d{3}[\dXx](?!\d)/g, '[身份证号已移除]')
    .replace(/[\p{Script=Han}]{2,20}(?:小学|学校|中学)/gu, '[学校已移除]')
    .replace(/((?:姓名|学校|班级|地址|住址)\s*[:：])\s*[^\s，,。；;\n]{1,30}/g, '$1[已移除]')
    .replace(/((?:学号|账号|帐号|考号)\s*[:：]?\s*)[A-Z0-9_-]{4,32}/gi, '$1[已移除]')
    .trim();
}

function useSlice(
  ageBand: OpenAssessmentAgeBand,
  input: ResolvedOpenAssessmentInput,
  taskType: OpenAssessmentTaskType,
): CapabilityUseSlice {
  return {
    basisState: input.requiresProfessionalReview ? 'conflicted' : 'current',
    gradeBand: ageBand,
    imageQuality: 'not_applicable',
    questionType: taskType === 'mathematics_process' ? 'process' : 'open_response',
    riskLevel: input.requiresProfessionalReview ? 'high' : 'medium',
    subject: input.question.subject,
  };
}

function authorizationSnapshot(
  decision: AuthorizationDecision,
): SuggestedAssessmentAuthorizationSnapshot {
  return {
    containmentEpoch: decision.containmentEpoch,
    decisionId: decision.decisionId,
    degradedReason: decision.degradedReason,
    issuedAt: decision.issuedAt,
  };
}

function view(item: StoredSuggestedAssessment): SuggestedAssessmentView {
  return {
    acceptedResult: structuredClone(item.acceptedResult),
    aiDisclosure: DISCLOSURE,
    authorizationDecision: item.authorization
      ? {
          containmentEpoch: item.authorization.containmentEpoch,
          id: item.authorization.decisionId,
          issuedAt: item.authorization.issuedAt,
        }
      : null,
    capabilityVersion: structuredClone(item.capability),
    citations: {
      learningBasis: {
        selectionVersion: item.basis.selectionVersion,
        sourceVersionId: item.basis.sourceVersionId,
        validityEpoch: item.basis.validityEpoch,
        versionLabel: item.basis.versionLabel,
      },
      rubric: item.rubric
        ? {
            id: item.rubric.id,
            name: item.rubric.name,
            sourceAuthority: item.rubric.source.authority,
            sourceLabel: item.rubric.source.label,
            version: item.rubric.version,
          }
        : null,
    },
    createdAt: item.createdAt,
    familySpaceId: item.familySpaceId,
    id: item.id,
    learningProfileId: item.learningProfileId,
    review: structuredClone(item.review),
    stateRevision: item.stateRevision,
    status: item.status,
    suggestion: structuredClone(item.suggestion),
    unavailable: unavailableDetail(item.unavailableReason),
    unavailableReason: item.unavailableReason,
    updatedAt: item.updatedAt,
  };
}

function unavailableDetail(reason: SuggestedAssessmentUnavailableReason | null) {
  if (!reason) return null;
  const details = {
    CAPABILITY_UNAVAILABLE: {
      explanation: '当前没有通过质量授权的 AI 建议评价能力，因此不会给出评价。',
      needs: ['已通过质量门禁的能力版本'],
    },
    LOW_CONFIDENCE: {
      explanation: '现有作答证据不足以支持可靠的分维度建议，因此选择不评价。',
      needs: ['更清晰或更完整的作答证据', '人工复核'],
    },
    MODEL_UNAVAILABLE: {
      explanation: 'AI 服务暂时不可用，因此不会猜测评价。',
      needs: ['稍后重试或人工复核'],
    },
    RUBRIC_REQUIRED: {
      explanation: '开放题必须先有适用且可信的评分量规，AI 不能临时创造评价维度。',
      needs: ['适用评分量规'],
    },
    SOURCE_CHANGED: {
      explanation: '当前学习依据已经变化，原建议不能继续使用。',
      needs: ['基于最新学习依据重新评价'],
    },
  } satisfies Record<
    SuggestedAssessmentUnavailableReason,
    { explanation: string; needs: string[] }
  >;
  return { ...details[reason], reason };
}

function checkedCandidate(
  value: OpenAssessmentModelCandidate,
  input: ResolvedOpenAssessmentInput & {
    rubric: NonNullable<ResolvedOpenAssessmentInput['rubric']>;
  },
): OpenAssessmentModelCandidate {
  const rubricKeys = input.rubric.dimensions.map(({ key }) => key);
  if (
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    value.dimensions.length !== rubricKeys.length ||
    new Set(value.dimensions.map(({ dimensionKey }) => dimensionKey)).size !== rubricKeys.length ||
    value.dimensions.some(
      (dimension) =>
        !rubricKeys.includes(dimension.dimensionKey) ||
        !Number.isFinite(dimension.confidence) ||
        dimension.confidence < 0 ||
        dimension.confidence > 1 ||
        ![
          'demonstrated',
          'partially_demonstrated',
          'not_demonstrated',
          'insufficient_evidence',
        ].includes(dimension.state) ||
        (dimension.evidenceExcerpt !== null &&
          !input.response.text.includes(dimension.evidenceExcerpt)),
    ) ||
    !rubricKeys.includes(value.improvementDimensionKey)
  ) {
    throw new AssessmentError('INPUT_INVALID', 'AI 建议未严格遵循适用评分量规或作答证据');
  }
  const candidate = structuredClone(value);
  candidate.strengthEvidence = requiredText(candidate.strengthEvidence, '做得好的证据', 800);
  candidate.nextAction = requiredText(candidate.nextAction, '下一步提示', 800);
  for (const dimension of candidate.dimensions) {
    dimension.observation = requiredText(dimension.observation, '维度观察', 800);
    dimension.improvementSuggestion = requiredText(
      dimension.improvementSuggestion,
      '维度改进建议',
      800,
    );
  }
  const allText = JSON.stringify(candidate);
  if (/(官方成绩|正式分数|总分|百分制|智力|人格|性格)/i.test(allText)) {
    throw new AssessmentError('INPUT_INVALID', 'AI 建议包含不允许的成绩或学习者特征推断');
  }
  return candidate;
}

function modelRun(
  result: OpenAssessmentModelResult | null,
  decision: AuthorizationDecision,
  finishedAt: string,
  succeeded: boolean,
) {
  const capability = decision.primary!.capabilityVersion;
  return {
    authorizationDecisionId: decision.decisionId,
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

function isAuthorized(decision: AuthorizationDecision): boolean {
  return (
    decision.status === 'authorized' &&
    decision.degradedReason === null &&
    decision.primary?.capabilityVersion.capabilityKey === 'ai.open-assessment-suggestion' &&
    decision.primary.capabilityVersion.kind === 'ai'
  );
}

export class SuggestedAssessmentService {
  readonly #basisReader: OpenAssessmentBasisReader;
  readonly #clock: { readonly now: Date };
  readonly #inputReader: OpenAssessmentInputReader;
  readonly #modelGateway: OpenAssessmentModelGatewayPort;
  readonly #publicationGate: OpenAssessmentPublicationGate;
  readonly #qualityControl: OpenAssessmentQualityControlPort;
  readonly #store: SuggestedAssessmentStore;

  constructor(dependencies: SuggestedAssessmentServiceDependencies) {
    this.#basisReader = dependencies.basisReader;
    this.#clock =
      dependencies.clock ??
      ({
        get now() {
          return new Date();
        },
      } as const);
    this.#inputReader = dependencies.inputReader;
    this.#modelGateway = dependencies.modelGateway;
    this.#publicationGate = dependencies.publicationGate;
    this.#qualityControl = dependencies.qualityControl;
    this.#store = dependencies.store;
  }

  async suggest(input: {
    actor: AssessmentActorReference;
    ageBand: OpenAssessmentAgeBand;
    consentRevision: number;
    familySpaceId: string;
    inputReference: ObjectiveAssessmentInputReference;
    learningProfileId: string;
    materialId: string;
    taskType: OpenAssessmentTaskType;
  }): Promise<SuggestedAssessmentView> {
    if (TASK_SUBJECT[input.taskType] === undefined) {
      throw new AssessmentError('INPUT_INVALID', '暂不支持这种开放题评价任务');
    }
    const basis = await this.#basisReader.getCurrentBasisReference({
      actor: input.actor,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    if (basis.materialId !== input.materialId) {
      throw new AssessmentError('BASIS_CHANGED', '当前学习依据已经变化，请刷新后重新评价');
    }
    const resolved = await this.#inputReader.resolveOpenAssessmentInput({
      actor: input.actor,
      ageBand: input.ageBand,
      basis,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      reference: structuredClone(input.inputReference),
      taskType: input.taskType,
    });
    if (!resolved) {
      throw new AssessmentError(
        'TRUSTED_INPUT_NOT_FOUND',
        '没有找到与当前学习依据匹配的已确认题目和作答',
      );
    }
    if (
      resolved.question.subject !== TASK_SUBJECT[input.taskType] ||
      (resolved.rubric &&
        (resolved.rubric.subject !== resolved.question.subject ||
          resolved.rubric.taskType !== input.taskType ||
          resolved.rubric.ageBand !== input.ageBand))
    ) {
      throw new AssessmentError('INPUT_INVALID', '适用评分量规与学科、题型或年龄层级不一致');
    }
    const now = this.#clock.now.toISOString();
    const question = {
      contentHash: contentHash('question', resolved.question.versionId, resolved.question.text),
      subject: resolved.question.subject,
      text: requiredText(resolved.question.text, '题目'),
      versionId: requiredText(resolved.question.versionId, '题目版本', 500),
    };
    const response = {
      contentHash: contentHash('response', resolved.response.versionId, resolved.response.text),
      text: requiredText(resolved.response.text, '作答'),
      versionId: requiredText(resolved.response.versionId, '作答版本', 500),
    };
    if (!Number.isInteger(input.consentRevision) || input.consentRevision < 1) {
      throw new AssessmentError('INPUT_INVALID', 'AI 处理同意版本无效');
    }
    const consentGranted = await this.#publicationGate.authorize({
      ageBand: input.ageBand,
      consentRevision: input.consentRevision,
      familySpaceId: input.familySpaceId,
      learningProfileId: input.learningProfileId,
    });
    if (!consentGranted) {
      throw new AssessmentError(
        'AI_PROCESSING_CONSENT_REQUIRED',
        'AI 处理同意已撤回或版本已变化，不能生成建议评价',
      );
    }
    const decision = await this.#qualityControl.authorizeCapability({
      capabilityKey: 'ai.open-assessment-suggestion',
      familySpaceId: input.familySpaceId,
      kind: 'ai',
      slice: useSlice(input.ageBand, resolved, input.taskType),
    });
    const key = hash({
      ageBand: input.ageBand,
      basis,
      capabilityVersionId: decision.primary?.capabilityVersion.id ?? null,
      inputReference: input.inputReference,
      question,
      response,
      rubric: resolved.rubric,
      taskType: input.taskType,
    });
    const existing = await this.#store.findByDeduplicationKey(key, input.learningProfileId);
    if (existing) return view(existing);

    let suggestion: OpenAssessmentModelCandidate | null = null;
    let modelResult: OpenAssessmentModelResult | null = null;
    let modelAttempted = false;
    let modelSucceeded = false;
    let unavailableReason: SuggestedAssessmentUnavailableReason | null = null;
    if (!resolved.rubric) {
      unavailableReason = 'RUBRIC_REQUIRED';
    } else if (!isAuthorized(decision)) {
      unavailableReason = 'CAPABILITY_UNAVAILABLE';
    } else {
      modelAttempted = true;
      try {
        modelResult = await this.#modelGateway.runStructured({
          ageBand: input.ageBand,
          capability: structuredClone(decision.primary!.capabilityVersion),
          learningBasis: structuredClone(basis),
          purpose: 'open_assessment_suggestion',
          question: { subject: question.subject, text: sanitizeModelText(question.text) },
          response: { text: sanitizeModelText(response.text) },
          rubric: structuredClone(resolved.rubric),
          taskType: input.taskType,
        });
        if (modelResult.provider !== decision.primary!.capabilityVersion.provider.id) {
          throw new Error('MODEL_PROVIDER_MISMATCH');
        }
        suggestion = checkedCandidate(modelResult.candidate, {
          ...resolved,
          question,
          response,
          rubric: resolved.rubric,
        });
        modelSucceeded = true;
      } catch {
        suggestion = null;
        unavailableReason = 'MODEL_UNAVAILABLE';
      }
      if (
        suggestion &&
        (suggestion.confidence < 0.75 ||
          suggestion.dimensions.some(({ confidence }) => confidence < 0.75))
      ) {
        suggestion = null;
        unavailableReason = 'LOW_CONFIDENCE';
      }
    }
    if (
      !(await this.#publicationGate.authorize({
        ageBand: input.ageBand,
        consentRevision: input.consentRevision,
        familySpaceId: input.familySpaceId,
        learningProfileId: input.learningProfileId,
      }))
    ) {
      throw new AssessmentError(
        'AI_PROCESSING_CONSENT_REQUIRED',
        'AI 处理同意在生成期间已撤回，建议评价不会发布',
      );
    }
    const item: StoredSuggestedAssessment = {
      acceptedResult: null,
      actor: structuredClone(input.actor),
      ageBand: input.ageBand,
      authorization: authorizationSnapshot(decision),
      basis: structuredClone(basis),
      capability: isAuthorized(decision)
        ? structuredClone(decision.primary!.capabilityVersion)
        : null,
      consentRevision: input.consentRevision,
      createdAt: now,
      deduplicationKey: key,
      familySpaceId: requiredText(input.familySpaceId, '家庭空间', 200),
      id: randomUUID(),
      inputReference: structuredClone(input.inputReference),
      learningProfileId: requiredText(input.learningProfileId, '学习档案', 200),
      materialId: requiredText(input.materialId, '学习资料', 200),
      modelRun: modelAttempted ? modelRun(modelResult, decision, now, modelSucceeded) : null,
      question,
      requiresProfessionalReview: resolved.requiresProfessionalReview,
      response,
      review: null,
      rubric: structuredClone(resolved.rubric),
      stateRevision: 1,
      status: unavailableReason ? 'unavailable' : 'pending_review',
      suggestion,
      taskType: input.taskType,
      unavailableReason,
      updatedAt: now,
    };
    if (!(await this.#store.create(item))) {
      const concurrent = await this.#store.findByDeduplicationKey(key, input.learningProfileId);
      if (concurrent) return view(concurrent);
      throw new AssessmentError('VERSION_CONFLICT', '建议评价状态已变化，请刷新后重试');
    }
    return view(item);
  }

  async getSuggestion(input: {
    actor: AssessmentActorReference;
    learningProfileId: string;
    suggestionId: string;
  }): Promise<SuggestedAssessmentView> {
    const item = await this.#store.findById(
      requiredText(input.suggestionId, '建议评价', 200),
      requiredText(input.learningProfileId, '学习档案', 200),
    );
    if (!item) {
      throw new AssessmentError('ASSESSMENT_NOT_FOUND', '没有找到这次建议评价');
    }
    await this.#requireCurrentBasis(item, input.actor);
    if (
      !(await this.#publicationGate.authorize({
        ageBand: item.ageBand,
        consentRevision: item.consentRevision,
        familySpaceId: item.familySpaceId,
        learningProfileId: item.learningProfileId,
      }))
    ) {
      throw new AssessmentError(
        'AI_PROCESSING_CONSENT_REQUIRED',
        'AI 处理同意已撤回，建议评价当前不可展示',
      );
    }
    return view(item);
  }

  async review(input: {
    decisions: OpenAssessmentReviewDecision[];
    expectedStateRevision: number;
    learningProfileId: string;
    reviewer: AssessmentActorReference | OpenAssessmentReviewerReference;
    suggestionId: string;
  }): Promise<SuggestedAssessmentView> {
    if (input.reviewer.type === 'learner') {
      throw new AssessmentError(
        'SUGGESTION_REVIEW_REQUIRES_ADULT',
        '学习者不能接受自己的建议评价，需要有权成年人复核',
      );
    }
    const item = await this.#store.findById(input.suggestionId, input.learningProfileId);
    if (!item) {
      throw new AssessmentError('ASSESSMENT_NOT_FOUND', '没有找到这次建议评价');
    }
    if (item.status !== 'pending_review' || !item.suggestion || !item.rubric || !item.capability) {
      throw new AssessmentError('SUGGESTION_NOT_REVIEWABLE', '这次建议评价当前不能被接受或修改');
    }
    if (item.requiresProfessionalReview && input.reviewer.type !== 'professional') {
      throw new AssessmentError(
        'PROFESSIONAL_REVIEW_REQUIRED',
        '这次评价涉及高影响、依据冲突或合理答案争议，需要专业复核',
      );
    }
    await this.#requireCurrentBasis(item, input.reviewer);
    const reviewable = item as StoredSuggestedAssessment & {
      capability: NonNullable<StoredSuggestedAssessment['capability']>;
      rubric: NonNullable<StoredSuggestedAssessment['rubric']>;
      suggestion: NonNullable<StoredSuggestedAssessment['suggestion']>;
    };
    const decisions = this.#checkedDecisions(input.decisions, reviewable);
    const rejected = decisions.some(({ action }) => action === 'reject');
    if (!rejected) {
      if (
        !(await this.#publicationGate.authorize({
          ageBand: item.ageBand,
          consentRevision: item.consentRevision,
          familySpaceId: item.familySpaceId,
          learningProfileId: item.learningProfileId,
        }))
      ) {
        throw new AssessmentError(
          'AI_PROCESSING_CONSENT_REQUIRED',
          'AI 处理同意已撤回或版本已变化，建议评价不能形成批改结果',
        );
      }
      const authorization = item.authorization;
      if (!authorization) {
        throw new AssessmentError('CAPABILITY_UNAVAILABLE', '建议评价缺少可复核的能力授权记录');
      }
      const revalidated = await this.#qualityControl.revalidateAuthorization({
        decisionId: authorization.decisionId,
        expectedContainmentEpoch: authorization.containmentEpoch,
        phase: 'before_publish',
        route: 'primary',
      });
      if (
        revalidated.status !== 'authorized' ||
        revalidated.capabilityVersion.id !== item.capability.id ||
        revalidated.decisionId !== authorization.decisionId
      ) {
        throw new AssessmentError(
          'CAPABILITY_UNAVAILABLE',
          '建议评价能力已停用或授权已变化，不能形成批改结果',
        );
      }
    }
    const reviewedAt = this.#clock.now.toISOString();
    const reviewer = structuredClone(input.reviewer) as OpenAssessmentReviewerReference;
    const review = {
      capabilityVersionId: item.capability.id,
      decisions: structuredClone(decisions),
      id: randomUUID(),
      questionVersionId: item.question.versionId,
      responseVersionId: item.response.versionId,
      reviewedAt,
      reviewedBy: reviewer,
      rubricId: item.rubric.id,
      rubricVersion: item.rubric.version,
    };
    const acceptedResult: AcceptedOpenAssessmentResult | null = rejected
      ? null
      : {
          capabilityVersionId: item.capability.id,
          dimensions: decisions.map((decision) => {
            const original = item.suggestion!.dimensions.find(
              ({ dimensionKey }) => dimensionKey === decision.dimensionKey,
            )!;
            return decision.action === 'modify'
              ? {
                  ...structuredClone(decision.modification),
                  decision: 'modified' as const,
                  dimensionKey: decision.dimensionKey,
                }
              : {
                  decision: 'accepted' as const,
                  dimensionKey: original.dimensionKey,
                  evidenceExcerpt: original.evidenceExcerpt,
                  improvementSuggestion: original.improvementSuggestion,
                  observation: original.observation,
                  state: original.state,
                };
          }),
          feedback: {
            improvementDimensionKey: item.suggestion.improvementDimensionKey,
            nextAction: item.suggestion.nextAction,
            strengthEvidence: item.suggestion.strengthEvidence,
          },
          id: randomUUID(),
          reviewRecordId: review.id,
          rubricId: item.rubric.id,
          rubricVersion: item.rubric.version,
          version: 1,
        };
    const saved = await this.#store.review({
      acceptedResult,
      expectedStateRevision: input.expectedStateRevision,
      learningProfileId: item.learningProfileId,
      review,
      status: rejected ? 'rejected' : 'accepted',
      suggestionId: item.id,
      updatedAt: reviewedAt,
    });
    if (!saved) {
      throw new AssessmentError('VERSION_CONFLICT', '建议评价已被其他复核操作更新，请刷新后重试');
    }
    item.acceptedResult = acceptedResult;
    item.review = review;
    item.stateRevision += 1;
    item.status = rejected ? 'rejected' : 'accepted';
    item.updatedAt = reviewedAt;
    return view(item);
  }

  #checkedDecisions(
    decisions: OpenAssessmentReviewDecision[],
    item: StoredSuggestedAssessment & {
      rubric: NonNullable<StoredSuggestedAssessment['rubric']>;
      suggestion: NonNullable<StoredSuggestedAssessment['suggestion']>;
    },
  ): OpenAssessmentReviewDecision[] {
    const keys = item.rubric.dimensions.map(({ key }) => key);
    if (
      decisions.length !== keys.length ||
      new Set(decisions.map(({ dimensionKey }) => dimensionKey)).size !== keys.length ||
      decisions.some(({ dimensionKey }) => !keys.includes(dimensionKey))
    ) {
      throw new AssessmentError('INPUT_INVALID', '必须逐一复核评分量规中的全部评价维度');
    }
    return decisions.map((decision) => {
      if (decision.action === 'accept') return structuredClone(decision);
      const reason = requiredText(decision.reason, '复核原因', 800);
      if (decision.action === 'reject') return { ...structuredClone(decision), reason };
      const modification = structuredClone(decision.modification);
      if (
        ![
          'demonstrated',
          'partially_demonstrated',
          'not_demonstrated',
          'insufficient_evidence',
        ].includes(modification.state) ||
        (modification.evidenceExcerpt !== null &&
          !item.response.text.includes(modification.evidenceExcerpt))
      ) {
        throw new AssessmentError('INPUT_INVALID', '修改后的维度结论必须引用当前作答证据');
      }
      modification.observation = requiredText(modification.observation, '修改后的维度观察', 800);
      modification.improvementSuggestion = requiredText(
        modification.improvementSuggestion,
        '修改后的改进建议',
        800,
      );
      return { ...structuredClone(decision), modification, reason };
    });
  }

  async #requireCurrentBasis(
    item: StoredSuggestedAssessment,
    actor: AssessmentActorReference | OpenAssessmentReviewerReference,
  ): Promise<void> {
    const current = await this.#basisReader.getCurrentBasisReference({
      actor:
        actor.type === 'professional' ? { id: item.learningProfileId, type: 'learner' } : actor,
      learningProfileId: item.learningProfileId,
      materialId: item.materialId,
    });
    if (
      current.sourceVersionId !== item.basis.sourceVersionId ||
      current.selectionVersion !== item.basis.selectionVersion ||
      current.validityEpoch !== item.basis.validityEpoch ||
      current.contentHash !== item.basis.contentHash
    ) {
      throw new AssessmentError('BASIS_CHANGED', '当前学习依据已经变化，请重新评价');
    }
  }

  async getAcceptedResultReference(input: {
    actor: AssessmentActorReference;
    learningProfileId: string;
    suggestionId: string;
  }) {
    const item = await this.#store.findById(input.suggestionId, input.learningProfileId);
    if (!item) {
      throw new AssessmentError('ASSESSMENT_NOT_FOUND', '没有找到这次建议评价');
    }
    await this.#requireCurrentBasis(item, input.actor);
    const reference = await this.#store.readAcceptedResultReference({
      learningProfileId: item.learningProfileId,
      suggestionId: item.id,
    });
    if (!reference) {
      throw new AssessmentError(
        'DOWNSTREAM_INELIGIBLE',
        '建议评价尚未由有权成年人接受，不能进入错题、掌握度或学习报告',
      );
    }
    return reference;
  }
}
