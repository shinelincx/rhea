import { createHash, randomUUID } from 'node:crypto';

import type { CurrentLearningBasisReference } from '@rhea/learning-content';

import { AssessmentError } from './error.js';
import type { AssessmentStore } from './store.js';
import type {
  AssessmentActorReference,
  AssessmentDispute,
  AssessmentDisputeResolution,
  AssessmentDisputeTarget,
  DownstreamAssessmentReference,
  ObjectiveAssessment,
  ObjectiveAssessmentInputReference,
  ObjectiveGradingRule,
  QuestionVersionSnapshot,
  ResolvedObjectiveAssessmentInput,
  ResponseVersionSnapshot,
  StoredObjectiveAssessment,
} from './types.js';

const SUBJECTS = new Set(['chinese', 'mathematics', 'english', 'science']);
const DISPUTE_TARGETS = new Set<AssessmentDisputeTarget>(['assessment', 'question', 'response']);

export interface LearningBasisReader {
  getCurrentBasisReference(input: {
    actor: AssessmentActorReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<CurrentLearningBasisReference>;
}

export interface ObjectiveAssessmentInputReader {
  resolveObjectiveInput(input: {
    actor: AssessmentActorReference;
    basis: CurrentLearningBasisReference;
    learningProfileId: string;
    materialId: string;
    reference: ObjectiveAssessmentInputReference;
  }): Promise<ResolvedObjectiveAssessmentInput | null>;
}

export interface AssessmentServiceDependencies {
  basisReader: LearningBasisReader;
  clock?: { readonly now: Date };
  inputReader: ObjectiveAssessmentInputReader;
  store: AssessmentStore;
}

function canonicalDecimal(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const magnitude = fraction ? `${whole}.${fraction}` : whole;
  return magnitude === '0' ? '0' : `${match[1] === '-' ? '-' : ''}${magnitude}`;
}

function checkedHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new AssessmentError('INPUT_INVALID', '题目和作答版本摘要必须是 SHA-256');
  }
  return normalized;
}

function requiredText(value: string, label: string, maximum = 4_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AssessmentError('INPUT_INVALID', `${label}不能为空且不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function trustedContentHash(
  kind: 'question' | 'response',
  versionId: string,
  text: string,
): string {
  return createHash('sha256').update(`${kind}\u001f${versionId}\u001f${text}`).digest('hex');
}

function checkedRule(rule: ObjectiveGradingRule | null): ObjectiveGradingRule | null {
  if (!rule) return null;
  if (rule.kind === 'numeric') {
    if (rule.expected.length > 120) {
      throw new AssessmentError('INPUT_INVALID', '数值答案不能超过 120 个字符');
    }
    return { expected: rule.expected.trim(), kind: rule.kind };
  }
  if (rule.kind === 'single_choice') {
    if (rule.correctOption.length > 120) {
      throw new AssessmentError('INPUT_INVALID', '正确选项不能超过 120 个字符');
    }
    return { correctOption: rule.correctOption.trim(), kind: rule.kind };
  }
  if (rule.kind === 'accepted_text') {
    if (
      rule.acceptedAnswers.length > 20 ||
      rule.acceptedAnswers.some((answer) => answer.length > 500)
    ) {
      throw new AssessmentError('INPUT_INVALID', '可接受答案最多 20 个且每个不超过 500 个字符');
    }
    return {
      ...rule,
      acceptedAnswers: rule.acceptedAnswers.map((answer) => answer.trim()),
    };
  }
  throw new AssessmentError('INPUT_INVALID', '暂不支持这种客观评价规则');
}

function normalizedText(
  value: string,
  options: { caseSensitive: boolean; collapseWhitespace: boolean },
): string {
  const whitespaceNormalized = options.collapseWhitespace
    ? value.trim().replace(/\s+/g, ' ')
    : value.trim();
  return options.caseSensitive ? whitespaceNormalized : whitespaceNormalized.toLocaleLowerCase();
}

function decision(questionText: string, responseText: string, rule: ObjectiveGradingRule | null) {
  if (!questionText.trim()) {
    return {
      expectedDisplay: null,
      normalizedResponse: responseText.trim() || null,
      outcome: 'ungradable' as const,
      reasonCode: 'QUESTION_INSUFFICIENT' as const,
    };
  }
  if (!rule) {
    return {
      expectedDisplay: null,
      normalizedResponse: responseText.trim() || null,
      outcome: 'ungradable' as const,
      reasonCode: 'BASIS_INSUFFICIENT' as const,
    };
  }
  if (rule.kind === 'numeric') {
    const expected = canonicalDecimal(rule.expected);
    const response = canonicalDecimal(responseText);
    if (expected === null) {
      return {
        expectedDisplay: null,
        normalizedResponse: response,
        outcome: 'ungradable' as const,
        reasonCode: 'BASIS_INSUFFICIENT' as const,
      };
    }
    return {
      expectedDisplay: expected,
      normalizedResponse: response,
      outcome: response === expected ? ('correct' as const) : ('incorrect' as const),
      reasonCode: null,
    };
  }
  if (rule.kind === 'accepted_text') {
    const accepted = rule.acceptedAnswers
      .map((answer) => normalizedText(answer, rule))
      .filter(Boolean);
    const response = normalizedText(responseText, rule);
    return accepted.length === 0
      ? {
          expectedDisplay: null,
          normalizedResponse: response || null,
          outcome: 'ungradable' as const,
          reasonCode: 'BASIS_INSUFFICIENT' as const,
        }
      : {
          expectedDisplay: accepted.join(' / '),
          normalizedResponse: response,
          outcome: accepted.includes(response) ? ('correct' as const) : ('incorrect' as const),
          reasonCode: null,
        };
  }
  const expected = rule.correctOption.trim().toLocaleUpperCase();
  const response = responseText.trim().toLocaleUpperCase();
  return expected
    ? {
        expectedDisplay: expected,
        normalizedResponse: response,
        outcome: response === expected ? ('correct' as const) : ('incorrect' as const),
        reasonCode: null,
      }
    : {
        expectedDisplay: null,
        normalizedResponse: response || null,
        outcome: 'ungradable' as const,
        reasonCode: 'BASIS_INSUFFICIENT' as const,
      };
}

function view(assessment: StoredObjectiveAssessment): ObjectiveAssessment {
  const { deduplicationKey: _deduplicationKey, ...visible } = structuredClone(assessment);
  return {
    ...visible,
    currentVersion: structuredClone(assessment.versions.at(-1)!),
  };
}

function ruleIdentity(rule: ObjectiveGradingRule | null): string {
  if (!rule) return 'ungradable';
  if (rule.kind === 'numeric') return `numeric:${rule.expected.trim()}`;
  if (rule.kind === 'single_choice') return `single_choice:${rule.correctOption.trim()}`;
  return `accepted_text:${rule.caseSensitive}:${rule.collapseWhitespace}:${[...rule.acceptedAnswers]
    .sort()
    .join('\u001e')}`;
}

function deduplicationKey(input: {
  basis: CurrentLearningBasisReference;
  learningProfileId: string;
  materialId: string;
  question: QuestionVersionSnapshot;
  response: ResponseVersionSnapshot;
  rule: ObjectiveGradingRule | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.learningProfileId,
        input.materialId,
        input.question.versionId,
        input.question.contentHash,
        input.response.versionId,
        input.response.contentHash,
        input.basis.sourceVersionId,
        String(input.basis.selectionVersion),
        String(input.basis.validityEpoch),
        ruleIdentity(input.rule),
      ].join('\u001f'),
    )
    .digest('hex');
}

function basisMatches(
  expected: CurrentLearningBasisReference,
  actual: CurrentLearningBasisReference,
): boolean {
  return (
    expected.materialId === actual.materialId &&
    expected.sourceVersionId === actual.sourceVersionId &&
    expected.selectionVersion === actual.selectionVersion &&
    expected.validityEpoch === actual.validityEpoch &&
    expected.contentHash === actual.contentHash
  );
}

export class AssessmentService {
  readonly #basisReader: LearningBasisReader;
  readonly #clock: { readonly now: Date };
  readonly #inputReader: ObjectiveAssessmentInputReader;
  readonly #store: AssessmentStore;

  constructor(dependencies: AssessmentServiceDependencies) {
    this.#basisReader = dependencies.basisReader;
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#inputReader = dependencies.inputReader;
    this.#store = dependencies.store;
  }

  async gradeObjective(input: {
    actor: AssessmentActorReference;
    familySpaceId: string;
    inputReference: ObjectiveAssessmentInputReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<ObjectiveAssessment> {
    const basis = await this.#basisReader.getCurrentBasisReference({
      actor: input.actor,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    if (basis.materialId !== input.materialId) {
      throw new AssessmentError('BASIS_CHANGED', '当前学习依据已经变化，请刷新后重新批改');
    }
    const inputReference = this.#checkedInputReference(input.inputReference);
    const resolved = await this.#resolveInput({
      actor: input.actor,
      basis,
      inputReference,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    const { question, response, rule } = resolved;
    const key = deduplicationKey({
      basis,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      question,
      response,
      rule,
    });
    const existing = await this.#store.findByDeduplicationKey(key, input.learningProfileId);
    if (existing) return view(existing);
    const version = {
      basis: structuredClone(basis),
      createdAt: this.#clock.now.toISOString(),
      createdBy: { ...input.actor },
      decision: decision(question.text, response.text, rule),
      gradingRuleVersionId: resolved.gradingRuleVersionId,
      id: randomUUID(),
      inputReference,
      predecessorId: null,
      question,
      requiresProfessionalReview: resolved.requiresProfessionalReview,
      response,
      revision: 1,
      rule: structuredClone(rule),
    };
    const assessment: StoredObjectiveAssessment = {
      deduplicationKey: key,
      disputes: [],
      familySpaceId: input.familySpaceId,
      id: randomUUID(),
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      openDisputeId: null,
      resolutions: [],
      versions: [version],
    };
    if (!(await this.#store.createAssessment(assessment))) {
      const concurrent = await this.#store.findByDeduplicationKey(key, input.learningProfileId);
      if (concurrent) return view(concurrent);
      throw new AssessmentError('VERSION_CONFLICT', '批改结果已被其他操作更新，请刷新后重试');
    }
    return view(assessment);
  }

  async getDownstreamReference(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    learningProfileId: string;
  }): Promise<DownstreamAssessmentReference> {
    const assessment = await this.#requireAssessment(input.assessmentId, input.learningProfileId);
    const currentBasis = await this.#basisReader.getCurrentBasisReference({
      actor: input.actor,
      learningProfileId: assessment.learningProfileId,
      materialId: assessment.materialId,
    });
    const read = await this.#store.readDownstreamReference({
      actor: input.actor,
      assessmentId: assessment.id,
      currentBasis,
      learningProfileId: assessment.learningProfileId,
    });
    if (read.kind === 'not_found') {
      throw new AssessmentError('ASSESSMENT_NOT_FOUND', '没有找到这道题的批改记录');
    }
    if (read.kind === 'basis_changed') {
      throw new AssessmentError('BASIS_CHANGED', '当前学习依据已经变化，请重新批改');
    }
    if (read.kind === 'ineligible') {
      throw new AssessmentError(
        'DOWNSTREAM_INELIGIBLE',
        read.reason === 'disputed'
          ? '批改质疑尚未解决，相关结论已暂停使用'
          : '暂无法批改的题目不能进入下游学习记录',
      );
    }
    return read.reference;
  }

  async getAssessment(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    learningProfileId: string;
  }): Promise<ObjectiveAssessment> {
    const assessment = await this.#requireAssessment(input.assessmentId, input.learningProfileId);
    await this.#recordAccess('assessment.read', input.actor, assessment);
    await this.#requireCurrentBasis(input.actor, assessment, assessment.versions.at(-1)!.basis);
    return view(assessment);
  }

  async raiseDispute(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    correctionText: string;
    learningProfileId: string;
    reason: string;
    target: AssessmentDisputeTarget;
  }): Promise<ObjectiveAssessment> {
    const assessment = await this.#requireAssessment(input.assessmentId, input.learningProfileId);
    const current = assessment.versions.at(-1)!;
    await this.#requireCurrentBasis(input.actor, assessment, current.basis);
    if (!DISPUTE_TARGETS.has(input.target)) {
      throw new AssessmentError('INPUT_INVALID', '质疑对象必须是题目、作答或批改结论');
    }
    const dispute: AssessmentDispute = {
      assessmentVersionId: current.id,
      correctionText: requiredText(input.correctionText, '补充修正信息'),
      id: randomUUID(),
      raisedAt: this.#clock.now.toISOString(),
      raisedBy: { ...input.actor },
      reason: requiredText(input.reason, '质疑原因', 500),
      reviewRoute:
        input.target === 'assessment' ||
        current.requiresProfessionalReview ||
        assessment.disputes.length > 0
          ? 'professional'
          : 'guardian',
      target: input.target,
    };
    const saved = await this.#store.appendDispute({
      assessmentId: assessment.id,
      dispute,
      expectedCurrentVersionId: current.id,
      learningProfileId: assessment.learningProfileId,
    });
    if (!saved) {
      throw new AssessmentError('VERSION_CONFLICT', '批改质疑状态已变化，请刷新后重试');
    }
    assessment.disputes.push(dispute);
    assessment.openDisputeId = dispute.id;
    return view(assessment);
  }

  async resolveDispute(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    disputeId: string;
    inputReference?: ObjectiveAssessmentInputReference;
    learningProfileId: string;
    reason: string;
  }): Promise<ObjectiveAssessment> {
    if (input.actor.type !== 'guardian') {
      throw new AssessmentError(
        'DISPUTE_RESOLUTION_REQUIRES_GUARDIAN',
        '批改质疑需要监护人核对后解决',
      );
    }
    const assessment = await this.#requireAssessment(input.assessmentId, input.learningProfileId);
    const dispute = assessment.disputes.find((candidate) => candidate.id === input.disputeId);
    if (!dispute || assessment.openDisputeId !== dispute.id) {
      throw new AssessmentError('DISPUTE_NOT_FOUND', '没有找到待解决的批改质疑');
    }
    if (dispute.reviewRoute === 'professional') {
      throw new AssessmentError(
        'PROFESSIONAL_REVIEW_REQUIRED',
        '这次质疑涉及批改结论、来源冲突或重复质疑，需要专业复核',
      );
    }
    const current = assessment.versions.at(-1)!;
    const basis = await this.#basisReader.getCurrentBasisReference({
      actor: input.actor,
      learningProfileId: input.learningProfileId,
      materialId: assessment.materialId,
    });
    const inputReference = this.#checkedInputReference(
      input.inputReference ?? current.inputReference,
    );
    const resolved = await this.#resolveInput({
      actor: input.actor,
      basis,
      inputReference,
      learningProfileId: assessment.learningProfileId,
      materialId: assessment.materialId,
    });
    const { question, response, rule } = resolved;
    const version = {
      basis: structuredClone(basis),
      createdAt: this.#clock.now.toISOString(),
      createdBy: { ...input.actor },
      decision: decision(question.text, response.text, rule),
      gradingRuleVersionId: resolved.gradingRuleVersionId,
      id: randomUUID(),
      inputReference: structuredClone(inputReference),
      predecessorId: current.id,
      question: structuredClone(question),
      requiresProfessionalReview: resolved.requiresProfessionalReview,
      response: structuredClone(response),
      revision: current.revision + 1,
      rule: structuredClone(rule),
    };
    const resolution: AssessmentDisputeResolution = {
      disputeId: dispute.id,
      id: randomUUID(),
      priorAssessmentVersionId: current.id,
      reason: requiredText(input.reason, '解决说明', 500),
      resolvedAt: this.#clock.now.toISOString(),
      resolvedBy: { ...input.actor, type: 'guardian' },
      resultingAssessmentVersionId: version.id,
    };
    const saved = await this.#store.resolveDispute({
      assessmentId: assessment.id,
      expectedCurrentVersionId: current.id,
      expectedOpenDisputeId: dispute.id,
      learningProfileId: assessment.learningProfileId,
      resolution,
      version,
    });
    if (!saved) {
      throw new AssessmentError('VERSION_CONFLICT', '批改质疑状态已变化，请刷新后重试');
    }
    assessment.versions.push(version);
    assessment.resolutions.push(resolution);
    assessment.openDisputeId = null;
    return view(assessment);
  }

  #checkedInputReference(
    reference: ObjectiveAssessmentInputReference,
  ): ObjectiveAssessmentInputReference {
    return {
      confirmedContentVersionId: requiredText(
        reference.confirmedContentVersionId,
        '已确认内容版本',
        200,
      ),
      processingJobId: requiredText(reference.processingJobId, '识别任务', 200),
      questionRegionId: requiredText(reference.questionRegionId, '题目区域', 200),
      responseRegionId: requiredText(reference.responseRegionId, '作答区域', 200),
    };
  }

  async #resolveInput(input: {
    actor: AssessmentActorReference;
    basis: CurrentLearningBasisReference;
    inputReference: ObjectiveAssessmentInputReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<{
    gradingRuleVersionId: string | null;
    question: QuestionVersionSnapshot;
    requiresProfessionalReview: boolean;
    response: ResponseVersionSnapshot;
    rule: ObjectiveGradingRule | null;
  }> {
    const resolved = await this.#inputReader.resolveObjectiveInput({
      actor: input.actor,
      basis: input.basis,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      reference: input.inputReference,
    });
    if (!resolved) {
      throw new AssessmentError(
        'TRUSTED_INPUT_NOT_FOUND',
        '没有找到与当前学习依据匹配的已确认题目和作答',
      );
    }
    const questionVersionId = requiredText(resolved.question.versionId, '题目版本', 400);
    const responseVersionId = requiredText(resolved.response.versionId, '作答版本', 400);
    const question = this.#checkedQuestion({
      ...resolved.question,
      contentHash: trustedContentHash('question', questionVersionId, resolved.question.text),
      versionId: questionVersionId,
    });
    const response = this.#checkedResponse({
      ...resolved.response,
      contentHash: trustedContentHash('response', responseVersionId, resolved.response.text),
      versionId: responseVersionId,
    });
    const rule = checkedRule(resolved.rule);
    if (Boolean(rule) !== Boolean(resolved.gradingRuleVersionId)) {
      throw new AssessmentError('INPUT_INVALID', '受控评价规则版本与规则内容不一致');
    }
    return {
      gradingRuleVersionId: resolved.gradingRuleVersionId
        ? requiredText(resolved.gradingRuleVersionId, '评价规则版本', 200)
        : null,
      question,
      requiresProfessionalReview: resolved.requiresProfessionalReview,
      response,
      rule,
    };
  }

  #checkedQuestion(question: QuestionVersionSnapshot): QuestionVersionSnapshot {
    const text = question.text.trim();
    if (text.length > 4_000 || !SUBJECTS.has(question.subject)) {
      throw new AssessmentError('INPUT_INVALID', '题目学科无效或内容超过 4000 个字符');
    }
    return {
      ...question,
      contentHash: checkedHash(question.contentHash),
      text,
      versionId: requiredText(question.versionId, '题目版本', 500),
    };
  }

  #checkedResponse(response: ResponseVersionSnapshot): ResponseVersionSnapshot {
    if (response.text.length > 4_000) {
      throw new AssessmentError('INPUT_INVALID', '作答不能超过 4000 个字符');
    }
    return {
      ...response,
      contentHash: checkedHash(response.contentHash),
      text: response.text.trim(),
      versionId: requiredText(response.versionId, '作答版本', 500),
    };
  }

  async #requireAssessment(
    id: string,
    learningProfileId: string,
  ): Promise<StoredObjectiveAssessment> {
    const assessment = await this.#store.findAssessment(id, learningProfileId);
    if (!assessment) {
      throw new AssessmentError('ASSESSMENT_NOT_FOUND', '没有找到这道题的批改记录');
    }
    return assessment;
  }

  async #recordAccess(
    action: string,
    actor: AssessmentActorReference,
    assessment: StoredObjectiveAssessment,
  ): Promise<void> {
    await this.#store.recordAccess({
      action,
      actor,
      assessmentId: assessment.id,
      familySpaceId: assessment.familySpaceId,
      learningProfileId: assessment.learningProfileId,
    });
  }

  async #requireCurrentBasis(
    actor: AssessmentActorReference,
    assessment: StoredObjectiveAssessment,
    expected: CurrentLearningBasisReference,
  ): Promise<void> {
    const current = await this.#basisReader.getCurrentBasisReference({
      actor,
      learningProfileId: assessment.learningProfileId,
      materialId: assessment.materialId,
    });
    if (!basisMatches(expected, current)) {
      throw new AssessmentError('BASIS_CHANGED', '当前学习依据已经变化，请重新批改');
    }
  }
}
