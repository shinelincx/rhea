import { createHash, randomUUID } from 'node:crypto';

import { AssessmentError, type AssessmentActorReference } from '@rhea/assessment';
import type { Subject } from '@rhea/learning-content';

import { LearningProgressError } from './error.js';
import type {
  AcceptedObjectiveAssessmentReader,
  LearningContextReader,
  MistakeReasonSuggestionProvider,
} from './ports.js';
import { conservativeMistakeReasonSuggestionProvider } from './reason-suggestion.js';
import type { LearningProgressStore } from './store.js';
import type {
  MistakeReasonCandidate,
  MistakeReasonCategory,
  MistakeReasonRevision,
  StoredWrongItem,
  WrongItemClassification,
  WrongItemFilter,
  WrongItemLibraryView,
  WrongItemThemeView,
  WrongItemView,
} from './types.js';

const SUBJECTS = new Set<Subject>(['chinese', 'mathematics', 'english', 'science']);
const REASON_CATEGORIES = new Set<MistakeReasonCategory>([
  'knowledge',
  'step',
  'comprehension',
  'reading',
  'expression',
  'other',
]);
const FORBIDDEN_LEARNER_LABELS = /(智力|智商|笨|懒|性格|人格|天赋|身份|不擅长)/i;

export interface LearningProgressServiceDependencies {
  assessmentReader: AcceptedObjectiveAssessmentReader;
  clock?: { readonly now: Date };
  learningContextReader: LearningContextReader;
  reasonSuggestionProvider?: MistakeReasonSuggestionProvider;
  store: LearningProgressStore;
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

function optionalText(value: string | null | undefined, label: string, maximum = 200) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, maximum);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function themeId(classification: WrongItemClassification, fallbackId: string): string {
  return classification.status === 'pending' || !classification.primaryKnowledgePointName
    ? `pending:${fallbackId}`
    : `topic:${digest({
        knowledgePointName: classification.primaryKnowledgePointName.toLocaleLowerCase(),
        subject: classification.subject,
        unitName: classification.unitName?.toLocaleLowerCase() ?? null,
      })}`;
}

function currentReason(item: StoredWrongItem): WrongItemView['currentReason'] {
  const latest = item.reasonHistory.at(-1);
  if (!latest) {
    return {
      category: item.reasonCandidate.category,
      explanation: item.reasonCandidate.explanation,
      status: 'suggested',
    };
  }
  return {
    category: latest.category,
    explanation: latest.explanation,
    status:
      latest.action === 'mark_uncertain'
        ? 'uncertain'
        : latest.action === 'correct'
          ? 'corrected'
          : latest.action === 'confirm'
            ? 'confirmed'
            : 'skipped',
  };
}

function view(item: StoredWrongItem): WrongItemView {
  return { ...structuredClone(item), currentReason: currentReason(item) };
}

function checkedCandidate(candidate: MistakeReasonCandidate): MistakeReasonCandidate {
  if (
    !REASON_CATEGORIES.has(candidate.category) ||
    candidate.hypothesisDisclosure !==
      '这是根据当前题目、作答和正确依据提出的可能错因，不是对学习者的事实判断。' ||
    FORBIDDEN_LEARNER_LABELS.test(candidate.explanation)
  ) {
    throw new LearningProgressError(
      'REASON_REVISION_INVALID',
      '错因建议必须保持为可修正的学习假设',
    );
  }
  return {
    ...structuredClone(candidate),
    explanation: requiredText(candidate.explanation, '错因建议', 800),
  };
}

function checkedClassification(
  input: {
    knowledgePointNames: string[];
    primaryKnowledgePointName: string | null;
    subject: Subject;
    unitName: string | null;
  },
  revision: number,
): WrongItemClassification {
  if (!SUBJECTS.has(input.subject)) {
    throw new LearningProgressError('CLASSIFICATION_INVALID', '错题主学科无效');
  }
  const knowledgePointNames = [
    ...new Map(
      input.knowledgePointNames.map((name) => {
        const checked = requiredText(name, '知识点', 200);
        return [checked.toLocaleLowerCase(), checked] as const;
      }),
    ).values(),
  ];
  const primaryKnowledgePointName = optionalText(input.primaryKnowledgePointName, '主要知识点');
  if (
    primaryKnowledgePointName &&
    !knowledgePointNames.some(
      (name) => name.toLocaleLowerCase() === primaryKnowledgePointName.toLocaleLowerCase(),
    )
  ) {
    throw new LearningProgressError('CLASSIFICATION_INVALID', '主要知识点必须属于当前知识点集合');
  }
  return {
    knowledgePointNames,
    primaryKnowledgePointName,
    revision,
    status: primaryKnowledgePointName ? 'classified' : 'pending',
    subject: input.subject,
    unitName: optionalText(input.unitName, '学习单元'),
  };
}

export class LearningProgressService {
  readonly #assessmentReader: AcceptedObjectiveAssessmentReader;
  readonly #clock: { readonly now: Date };
  readonly #learningContextReader: LearningContextReader;
  readonly #reasonSuggestionProvider: MistakeReasonSuggestionProvider;
  readonly #store: LearningProgressStore;

  constructor(dependencies: LearningProgressServiceDependencies) {
    this.#assessmentReader = dependencies.assessmentReader;
    this.#clock =
      dependencies.clock ??
      ({
        get now() {
          return new Date();
        },
      } as const);
    this.#learningContextReader = dependencies.learningContextReader;
    this.#reasonSuggestionProvider =
      dependencies.reasonSuggestionProvider ?? conservativeMistakeReasonSuggestionProvider;
    this.#store = dependencies.store;
  }

  async captureAcceptedError(input: {
    actor: AssessmentActorReference;
    assessmentId: string;
    learningProfileId: string;
  }): Promise<WrongItemView | null> {
    const assessment = await this.#assessmentReader.getAcceptedObjectiveAssessmentSnapshot(input);
    if (assessment.outcome === 'correct') return null;
    const context = await this.#learningContextReader.getCurrentLearningContextReference({
      actor: input.actor,
      learningProfileId: assessment.learningProfileId,
      materialId: assessment.materialId,
    });
    if (
      context.basis.sourceVersionId !== assessment.basis.sourceVersionId ||
      context.basis.selectionVersion !== assessment.basis.selectionVersion ||
      context.basis.validityEpoch !== assessment.basis.validityEpoch ||
      context.basis.contentHash !== assessment.basis.contentHash ||
      context.subject !== assessment.question.subject
    ) {
      throw new LearningProgressError('SOURCE_INELIGIBLE', '批改结果与当前学习依据或归类不一致');
    }
    const deduplicationKey = digest({
      assessmentId: assessment.assessmentId,
      assessmentVersionId: assessment.assessmentVersionId,
    });
    const existing = await this.#store.findByDeduplicationKey(
      deduplicationKey,
      assessment.learningProfileId,
    );
    if (existing) return view(existing);
    const id = randomUUID();
    const classification = checkedClassification(
      {
        knowledgePointNames: context.knowledgePointNames,
        primaryKnowledgePointName: context.primaryKnowledgePointName,
        subject: assessment.question.subject,
        unitName: context.unitName,
      },
      1,
    );
    const now = this.#clock.now.toISOString();
    const item: StoredWrongItem = {
      assessment: structuredClone(assessment),
      classification,
      correctionAttempts: [],
      createdAt: now,
      deduplicationKey,
      familySpaceId: assessment.familySpaceId,
      firstIncorrectAt: assessment.firstIncorrectAt,
      id,
      learningProfileId: assessment.learningProfileId,
      reasonCandidate: checkedCandidate(await this.#reasonSuggestionProvider.suggest(assessment)),
      reasonHistory: [],
      stateRevision: 1,
      status: 'pending_correction',
      themeId: themeId(classification, id),
      updatedAt: now,
    };
    if (!(await this.#store.createWrongItem(item))) {
      const concurrent = await this.#store.findByDeduplicationKey(
        deduplicationKey,
        assessment.learningProfileId,
      );
      if (concurrent) return view(concurrent);
      throw new LearningProgressError('VERSION_CONFLICT', '错题归集状态已变化，请刷新后重试');
    }
    return view(item);
  }

  async getWrongItem(input: {
    actor: AssessmentActorReference;
    learningProfileId: string;
    wrongItemId: string;
  }): Promise<WrongItemView> {
    const item = await this.#requireItem(input.wrongItemId, input.learningProfileId);
    await this.#requireCurrentAssessment(item, input.actor);
    await this.#store.recordAccess({
      action: 'wrong_item.read',
      actor: input.actor,
      familySpaceId: item.familySpaceId,
      learningProfileId: item.learningProfileId,
      wrongItemId: item.id,
    });
    return view(item);
  }

  async listWrongItems(input: {
    actor: AssessmentActorReference;
    filter?: WrongItemFilter;
    learningProfileId: string;
  }): Promise<WrongItemLibraryView> {
    const stored = await this.#store.listWrongItems(input.learningProfileId);
    const eligible: StoredWrongItem[] = [];
    for (const item of stored) {
      try {
        await this.#requireCurrentAssessment(item, input.actor);
        eligible.push(item);
      } catch (error) {
        if (
          (error instanceof AssessmentError &&
            ['BASIS_CHANGED', 'DOWNSTREAM_INELIGIBLE'].includes(error.code)) ||
          (error instanceof LearningProgressError && error.code === 'SOURCE_INELIGIBLE')
        ) {
          continue;
        }
        throw error;
      }
    }
    const filter = input.filter;
    const items = eligible.filter(
      (item) =>
        (!filter?.classificationStatus ||
          item.classification.status === filter.classificationStatus) &&
        (!filter?.subject || item.classification.subject === filter.subject) &&
        (!filter?.unitName || item.classification.unitName === filter.unitName) &&
        (!filter?.knowledgePointName ||
          item.classification.knowledgePointNames.includes(filter.knowledgePointName)),
    );
    await Promise.all(
      items.map((item) =>
        this.#store.recordAccess({
          action: 'wrong_item.library.read',
          actor: input.actor,
          familySpaceId: item.familySpaceId,
          learningProfileId: item.learningProfileId,
          wrongItemId: item.id,
        }),
      ),
    );
    const themes = new Map<string, WrongItemThemeView>();
    for (const item of items) {
      const current = themes.get(item.themeId);
      const candidate: WrongItemThemeView = {
        firstIncorrectAt:
          current && current.firstIncorrectAt < item.firstIncorrectAt
            ? current.firstIncorrectAt
            : item.firstIncorrectAt,
        id: item.themeId,
        itemCount: (current?.itemCount ?? 0) + 1,
        knowledgePointName: item.classification.primaryKnowledgePointName,
        status: item.classification.status,
        subject: item.classification.subject,
        unitName: item.classification.unitName,
      };
      themes.set(item.themeId, candidate);
    }
    return {
      items: items.sort((a, b) => a.firstIncorrectAt.localeCompare(b.firstIncorrectAt)).map(view),
      themes: [...themes.values()].sort((a, b) =>
        a.firstIncorrectAt.localeCompare(b.firstIncorrectAt),
      ),
    };
  }

  async reviseReason(input: {
    action: MistakeReasonRevision['action'];
    actor: AssessmentActorReference;
    category?: MistakeReasonCategory;
    expectedStateRevision: number;
    explanation?: string;
    learningProfileId: string;
    reason?: string;
    wrongItemId: string;
  }): Promise<WrongItemView> {
    const item = await this.#requireItem(input.wrongItemId, input.learningProfileId);
    await this.#requireCurrentAssessment(item, input.actor);
    if (!Number.isInteger(input.expectedStateRevision) || input.expectedStateRevision < 1) {
      throw new LearningProgressError('INPUT_INVALID', '错题状态版本无效');
    }
    let category: MistakeReasonCategory | null = item.reasonCandidate.category;
    let explanation: string | null = item.reasonCandidate.explanation;
    let reason: string | null = null;
    if (input.action === 'skip') {
      category = null;
      explanation = null;
    } else if (input.action === 'correct') {
      if (!input.category || !REASON_CATEGORIES.has(input.category)) {
        throw new LearningProgressError('REASON_REVISION_INVALID', '修正错因时必须选择有效类别');
      }
      category = input.category;
      explanation = requiredText(input.explanation ?? '', '修正后的错因', 800);
      reason = requiredText(input.reason ?? '', '修正说明', 800);
      if (FORBIDDEN_LEARNER_LABELS.test(explanation)) {
        throw new LearningProgressError('REASON_REVISION_INVALID', '错因不能使用能力或人格标签');
      }
    } else if (input.action === 'mark_uncertain') {
      reason = optionalText(input.reason, '不确定说明', 800);
    }
    const revision: MistakeReasonRevision = {
      action: input.action,
      actor: structuredClone(input.actor),
      category,
      changedAt: this.#clock.now.toISOString(),
      explanation,
      id: randomUUID(),
      reason,
      revision: item.reasonHistory.length + 1,
    };
    if (
      !(await this.#store.reviseReason({
        expectedStateRevision: input.expectedStateRevision,
        learningProfileId: item.learningProfileId,
        revision,
        updatedAt: revision.changedAt,
        wrongItemId: item.id,
      }))
    ) {
      throw new LearningProgressError('VERSION_CONFLICT', '错因已被其他操作更新，请刷新后重试');
    }
    item.reasonHistory.push(revision);
    item.stateRevision += 1;
    item.updatedAt = revision.changedAt;
    return view(item);
  }

  async reviseClassification(input: {
    actor: AssessmentActorReference;
    expectedStateRevision: number;
    knowledgePointNames: string[];
    learningProfileId: string;
    primaryKnowledgePointName: string | null;
    subject: Subject;
    unitName: string | null;
    wrongItemId: string;
  }): Promise<WrongItemView> {
    const item = await this.#requireItem(input.wrongItemId, input.learningProfileId);
    await this.#requireCurrentAssessment(item, input.actor);
    const classification = checkedClassification(input, item.classification.revision + 1);
    const updatedAt = this.#clock.now.toISOString();
    const nextThemeId = themeId(classification, item.id);
    if (
      !(await this.#store.reviseClassification({
        actor: input.actor,
        classification,
        expectedStateRevision: input.expectedStateRevision,
        learningProfileId: item.learningProfileId,
        themeId: nextThemeId,
        updatedAt,
        wrongItemId: item.id,
      }))
    ) {
      throw new LearningProgressError('VERSION_CONFLICT', '错题归类已被其他操作更新，请刷新后重试');
    }
    item.classification = classification;
    item.stateRevision += 1;
    item.themeId = nextThemeId;
    item.updatedAt = updatedAt;
    return view(item);
  }

  async submitImmediateCorrection(input: {
    actor: AssessmentActorReference;
    expectedStateRevision: number;
    idempotencyKey: string;
    learningProfileId: string;
    responseText: string;
    wrongItemId: string;
  }): Promise<WrongItemView> {
    const item = await this.#requireItem(input.wrongItemId, input.learningProfileId);
    await this.#requireCurrentAssessment(item, input.actor);
    const idempotencyKey = requiredText(input.idempotencyKey, 'Idempotency-Key', 200);
    const existing = item.correctionAttempts.find(
      (attempt) => attempt.idempotencyKey === idempotencyKey,
    );
    if (existing) return view(item);
    const evaluation = await this.#assessmentReader.evaluateImmediateCorrection({
      actor: input.actor,
      assessmentId: item.assessment.assessmentId,
      learningProfileId: item.learningProfileId,
      responseText: requiredText(input.responseText, '订正作答'),
    });
    if (
      evaluation.assessmentVersionId !== item.assessment.assessmentVersionId ||
      evaluation.basis.sourceVersionId !== item.assessment.basis.sourceVersionId ||
      evaluation.basis.selectionVersion !== item.assessment.basis.selectionVersion ||
      evaluation.basis.validityEpoch !== item.assessment.basis.validityEpoch
    ) {
      throw new LearningProgressError('SOURCE_INELIGIBLE', '原批改结果已经变化，不能继续订正');
    }
    const createdAt = this.#clock.now.toISOString();
    const attempt = {
      assessmentVersionId: evaluation.assessmentVersionId,
      basis: structuredClone(evaluation.basis),
      createdAt,
      id: randomUUID(),
      idempotencyKey,
      normalizedResponse: evaluation.normalizedResponse,
      outcome: evaluation.outcome,
      responseText: evaluation.evaluatedResponse,
    };
    const status =
      evaluation.outcome === 'correct' ? 'pending_consolidation' : 'pending_correction';
    if (
      !(await this.#store.recordCorrection({
        attempt,
        expectedStateRevision: input.expectedStateRevision,
        learningProfileId: item.learningProfileId,
        status,
        updatedAt: createdAt,
        wrongItemId: item.id,
      }))
    ) {
      throw new LearningProgressError('VERSION_CONFLICT', '订正状态已被其他操作更新，请刷新后重试');
    }
    item.correctionAttempts.push(attempt);
    item.stateRevision += 1;
    item.status = status;
    item.updatedAt = createdAt;
    return view(item);
  }

  async #requireCurrentAssessment(
    item: StoredWrongItem,
    actor: AssessmentActorReference,
  ): Promise<void> {
    const current = await this.#assessmentReader.getAcceptedObjectiveAssessmentSnapshot({
      actor,
      assessmentId: item.assessment.assessmentId,
      learningProfileId: item.learningProfileId,
    });
    if (
      current.outcome !== 'incorrect' ||
      current.assessmentVersionId !== item.assessment.assessmentVersionId ||
      current.basis.sourceVersionId !== item.assessment.basis.sourceVersionId ||
      current.basis.selectionVersion !== item.assessment.basis.selectionVersion ||
      current.basis.validityEpoch !== item.assessment.basis.validityEpoch ||
      current.question.contentHash !== item.assessment.question.contentHash ||
      current.response.contentHash !== item.assessment.response.contentHash
    ) {
      throw new LearningProgressError('SOURCE_INELIGIBLE', '错题依赖的批改结果已经变化');
    }
  }

  async #requireItem(id: string, learningProfileId: string): Promise<StoredWrongItem> {
    const item = await this.#store.findById(
      requiredText(id, '错题', 200),
      requiredText(learningProfileId, '学习档案', 200),
    );
    if (!item) throw new LearningProgressError('WRONG_ITEM_NOT_FOUND', '没有找到这道错题');
    return item;
  }
}
