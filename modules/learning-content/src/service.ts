import { createHash, randomUUID } from 'node:crypto';

import { LearningContentError } from './error.js';
import type { LearningContentStore } from './store.js';
import type {
  BasisSelectionVersion,
  ClassificationDraft,
  ClassificationVersion,
  CurrentLearningBasisReference,
  CurrentLearningContextReference,
  LearningActorReference,
  LearningMaterial,
  LearningSourceKind,
  LearningSourceVersion,
  StoredLearningMaterial,
  Subject,
} from './types.js';

const SUBJECTS = new Set<Subject>(['chinese', 'mathematics', 'english', 'science']);
const SOURCE_KINDS = new Set<LearningSourceKind>([
  'learning_material',
  'question',
  'answer',
  'grading_basis',
]);

export interface LearningContentServiceDependencies {
  clock?: { readonly now: Date };
  store: LearningContentStore;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 120) {
    throw new LearningContentError(
      'CLASSIFICATION_INVALID',
      `${label}不能为空且不能超过 120 个字符`,
    );
  }
  return normalized;
}

function optionalText(value: string | null, label: string): string | null {
  return value === null ? null : requiredText(value, label);
}

function checkedHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new LearningContentError('SOURCE_INVALID', '学习来源摘要必须是 SHA-256');
  }
  return normalized;
}

function stableId(...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('\u001f')).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function normalizeClassification(
  learningProfileId: string,
  draft: ClassificationDraft,
  metadata: {
    actor: LearningActorReference;
    changedAt: string;
    predecessorId: string | null;
    reason: string | null;
    revision: number;
    source: ClassificationVersion['source'];
  },
): ClassificationVersion {
  const primarySubject = draft.primarySubject;
  if (primarySubject !== null && !SUBJECTS.has(primarySubject)) {
    throw new LearningContentError('CLASSIFICATION_INVALID', '仅支持语文、数学、英语和科学');
  }
  const relatedSubjects = [...new Set(draft.relatedSubjects)];
  if (relatedSubjects.some((subject) => !SUBJECTS.has(subject) || subject === primarySubject)) {
    throw new LearningContentError('CLASSIFICATION_INVALID', '关联学科必须有效且不能与主学科重复');
  }

  const coursePathName = optionalText(draft.coursePathName, '课程路径');
  const unitName = optionalText(draft.unitName, '学习单元');
  const knowledgePointNames = [
    ...new Map(
      draft.knowledgePointNames.map((name) => {
        const normalized = requiredText(name, '知识点');
        return [normalized.toLocaleLowerCase('zh-CN'), normalized] as const;
      }),
    ).values(),
  ];
  const primaryKnowledgePointName = optionalText(draft.primaryKnowledgePointName, '主要知识点');

  if (
    primarySubject === null &&
    (coursePathName ||
      unitName ||
      knowledgePointNames.length ||
      primaryKnowledgePointName ||
      relatedSubjects.length)
  ) {
    throw new LearningContentError(
      'CLASSIFICATION_INVALID',
      '待归类内容不能携带系统猜测的课程路径、学习单元或知识点',
    );
  }
  if (
    primaryKnowledgePointName &&
    !knowledgePointNames.some(
      (name) =>
        name.toLocaleLowerCase('zh-CN') === primaryKnowledgePointName.toLocaleLowerCase('zh-CN'),
    )
  ) {
    throw new LearningContentError('CLASSIFICATION_INVALID', '主要知识点必须包含在知识点列表中');
  }

  const coursePath =
    primarySubject && coursePathName
      ? {
          id: stableId(
            'course-path',
            learningProfileId,
            primarySubject,
            coursePathName.toLowerCase(),
          ),
          name: coursePathName,
          subject: primarySubject,
        }
      : null;
  const unit =
    primarySubject && unitName
      ? {
          coursePathId: coursePath?.id ?? null,
          id: stableId(
            'learning-unit',
            learningProfileId,
            primarySubject,
            coursePath?.id ?? '',
            unitName.toLowerCase(),
          ),
          name: unitName,
          subject: primarySubject,
        }
      : null;
  return {
    changedAt: metadata.changedAt,
    changedBy: { ...metadata.actor },
    coursePath,
    id: randomUUID(),
    knowledgePoints: primarySubject
      ? knowledgePointNames.map((name) => ({
          id: randomUUID(),
          name,
          primary:
            primaryKnowledgePointName?.toLocaleLowerCase('zh-CN') ===
            name.toLocaleLowerCase('zh-CN'),
          subject: primarySubject,
        }))
      : [],
    predecessorId: metadata.predecessorId,
    primarySubject,
    reason: metadata.reason,
    relatedSubjects,
    revision: metadata.revision,
    source: metadata.source,
    status: primarySubject ? 'classified' : 'pending',
    unit,
  };
}

function view(material: StoredLearningMaterial): LearningMaterial {
  const currentClassification = material.classificationHistory.at(-1);
  const currentSelection = material.basisSelectionHistory.at(-1);
  if (!currentClassification || !currentSelection) {
    throw new Error('Stored learning material is missing required version history');
  }
  const current = material.sourceVersions.find(
    (source) => source.id === currentSelection.sourceVersionId,
  );
  if (!current) {
    throw new Error('Stored current learning basis no longer exists');
  }
  const conflictingSourceVersionIds = new Set<string>();
  for (const source of material.sourceVersions) {
    for (const other of material.sourceVersions) {
      if (
        source.id !== other.id &&
        source.contentHash !== other.contentHash &&
        (source.sourceKey === other.sourceKey ||
          source.conflictsWithSourceVersionIds.includes(other.id))
      ) {
        conflictingSourceVersionIds.add(source.id);
        conflictingSourceVersionIds.add(other.id);
      }
    }
  }
  return {
    ...structuredClone(material),
    basis: {
      conflictingSourceVersionIds: [...conflictingSourceVersionIds],
      currentSourceVersionId: current.id,
      hasConflict: conflictingSourceVersionIds.size > 0,
      selectionRevision: currentSelection.version,
    },
    currentClassification: structuredClone(currentClassification),
  };
}

function requireActive(material: StoredLearningMaterial): LearningMaterial {
  const current = view(material);
  if (current.invalidatedAt) {
    throw new LearningContentError(
      'UPSTREAM_INVALIDATED',
      '上游确认内容已变化，当前学习资料及其依据必须重新建立',
    );
  }
  return current;
}

export class LearningContentService {
  readonly #clock: { readonly now: Date };
  readonly #store: LearningContentStore;

  constructor(dependencies: LearningContentServiceDependencies) {
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#store = dependencies.store;
  }

  async organizeConfirmedContent(input: {
    actor: LearningActorReference;
    classification: ClassificationDraft;
    confirmedContentVersion: number;
    confirmedContentVersionId: string;
    familySpaceId: string;
    learningProfileId: string;
    sourceHash: string;
  }): Promise<LearningMaterial> {
    const createdAt = this.#clock.now.toISOString();
    const classification = normalizeClassification(input.learningProfileId, input.classification, {
      actor: input.actor,
      changedAt: createdAt,
      predecessorId: null,
      reason: null,
      revision: 1,
      source: 'initial',
    });
    const confirmedContentVersionId = requiredText(
      input.confirmedContentVersionId,
      '确认内容版本标识',
    );
    const sourceVersion: LearningSourceVersion = {
      conflictsWithSourceVersionIds: [],
      contentHash: checkedHash(input.sourceHash),
      createdAt,
      createdBy: { ...input.actor },
      id: randomUUID(),
      kind: 'learning_material',
      label: '已确认学习资料',
      sourceKey: `confirmed-content:${confirmedContentVersionId}`,
      sourceConfirmedContentVersionId: confirmedContentVersionId,
      versionLabel: `confirmed-content-v${input.confirmedContentVersion}`,
      versionNumber: 1,
    };
    const selection: BasisSelectionVersion = {
      id: randomUUID(),
      reason: '首次确认的学习资料',
      selectedAt: createdAt,
      selectedBy: { ...input.actor },
      sourceVersionId: sourceVersion.id,
      version: 1,
    };
    const stored: StoredLearningMaterial = {
      basisSelectionHistory: [selection],
      classificationHistory: [classification],
      confirmedContentVersionId,
      createdAt,
      familySpaceId: requiredText(input.familySpaceId, '家庭空间'),
      id: randomUUID(),
      invalidatedAt: null,
      invalidationReason: null,
      learningProfileId: requiredText(input.learningProfileId, '学习档案'),
      sourceHash: sourceVersion.contentHash,
      sourceVersions: [sourceVersion],
      validityEpoch: 1,
    };
    if (!(await this.#store.createMaterial(stored))) {
      throw new LearningContentError(
        'CONFIRMED_CONTENT_ALREADY_ORGANIZED',
        '这份确认内容已经整理过，请直接查看现有学习资料',
      );
    }
    return view(stored);
  }

  async getByConfirmedContent(input: {
    confirmedContentVersionId: string;
    learningProfileId: string;
  }): Promise<LearningMaterial> {
    const material = await this.#store.findByConfirmedContent(
      input.confirmedContentVersionId,
      input.learningProfileId,
    );
    if (!material) {
      throw new LearningContentError('MATERIAL_NOT_FOUND', '没有找到这份学习资料');
    }
    return requireActive(material);
  }

  async getMaterial(input: {
    actor: LearningActorReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<LearningMaterial> {
    const material = await this.#requireMaterial(input.materialId, input.learningProfileId);
    await this.#store.recordAccess({
      action: material.invalidatedAt
        ? 'learning_material.read_rejected_invalidated'
        : 'learning_material.read',
      actor: input.actor,
      familySpaceId: material.familySpaceId,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    return requireActive(material);
  }

  async getCurrentBasisReference(input: {
    actor: LearningActorReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<CurrentLearningBasisReference> {
    const stored = await this.#requireMaterial(input.materialId, input.learningProfileId);
    await this.#store.recordAccess({
      action: stored.invalidatedAt
        ? 'learning_material.current_basis_reference.read_rejected_invalidated'
        : 'learning_material.current_basis_reference.read',
      actor: input.actor,
      familySpaceId: stored.familySpaceId,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    const material = requireActive(stored);
    const source = material.sourceVersions.find(
      (candidate) => candidate.id === material.basis.currentSourceVersionId,
    )!;
    return {
      contentHash: source.contentHash,
      kind: source.kind,
      materialId: material.id,
      selectionVersion: material.basis.selectionRevision,
      sourceVersionId: source.id,
      validityEpoch: material.validityEpoch,
      versionLabel: source.versionLabel,
    };
  }

  async getCurrentLearningContextReference(input: {
    actor: LearningActorReference;
    learningProfileId: string;
    materialId: string;
  }): Promise<CurrentLearningContextReference> {
    const material = await this.getMaterial(input);
    const basisSource = material.sourceVersions.find(
      ({ id }) => id === material.basis.currentSourceVersionId,
    )!;
    return {
      basis: {
        contentHash: basisSource.contentHash,
        kind: basisSource.kind,
        materialId: material.id,
        selectionVersion: material.basis.selectionRevision,
        sourceVersionId: basisSource.id,
        validityEpoch: material.validityEpoch,
        versionLabel: basisSource.versionLabel,
      },
      classificationRevision: material.currentClassification.revision,
      confirmedContentVersionId: material.confirmedContentVersionId,
      coursePathName: material.currentClassification.coursePath?.name ?? null,
      knowledgePointNames: material.currentClassification.knowledgePoints.map(({ name }) => name),
      subject: material.currentClassification.primarySubject,
      unitName: material.currentClassification.unit?.name ?? null,
    };
  }

  async invalidateByConfirmedContent(input: {
    actor: LearningActorReference;
    confirmedContentVersionId: string;
    learningProfileId: string;
    reason: string;
  }): Promise<LearningMaterial> {
    const material = await this.#store.findByConfirmedContent(
      input.confirmedContentVersionId,
      input.learningProfileId,
    );
    if (!material) {
      throw new LearningContentError('MATERIAL_NOT_FOUND', '没有找到这份学习资料');
    }
    if (material.invalidatedAt) {
      return view(material);
    }
    const invalidatedAt = this.#clock.now.toISOString();
    const reason = requiredText(input.reason, '失效原因');
    const saved = await this.#store.invalidateMaterial({
      actor: input.actor,
      eventId: randomUUID(),
      expectedValidityEpoch: material.validityEpoch,
      invalidatedAt,
      learningProfileId: input.learningProfileId,
      materialId: material.id,
      reason,
    });
    if (!saved) {
      throw new LearningContentError('VERSION_CONFLICT', '学习依据有效性已变化，请刷新后重试');
    }
    material.invalidatedAt = invalidatedAt;
    material.invalidationReason = reason;
    material.validityEpoch += 1;
    return view(material);
  }

  async correctClassification(input: {
    actor: LearningActorReference;
    classification: ClassificationDraft;
    learningProfileId: string;
    materialId: string;
    reason: string;
  }): Promise<LearningMaterial> {
    const material = await this.#requireMaterial(input.materialId, input.learningProfileId);
    requireActive(material);
    const current = material.classificationHistory.at(-1)!;
    const classification = normalizeClassification(input.learningProfileId, input.classification, {
      actor: input.actor,
      changedAt: this.#clock.now.toISOString(),
      predecessorId: current.id,
      reason: requiredText(input.reason, '修正原因'),
      revision: current.revision + 1,
      source: 'correction',
    });
    const saved = await this.#store.appendClassification({
      classification,
      expectedRevision: current.revision,
      expectedValidityEpoch: material.validityEpoch,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    if (!saved) {
      throw new LearningContentError('VERSION_CONFLICT', '归类已被其他操作更新，请刷新后重试');
    }
    material.classificationHistory.push(classification);
    return view(material);
  }

  async addSourceVersion(input: {
    actor: LearningActorReference;
    conflictsWithSourceVersionIds?: string[];
    contentHash: string;
    kind: LearningSourceKind;
    label: string;
    learningProfileId: string;
    materialId: string;
    sourceKey?: string;
    versionLabel: string;
  }): Promise<LearningMaterial> {
    if (!SOURCE_KINDS.has(input.kind) || input.kind === 'learning_material') {
      throw new LearningContentError('SOURCE_INVALID', '补充来源必须是题目、答案或评分依据');
    }
    const material = await this.#requireMaterial(input.materialId, input.learningProfileId);
    requireActive(material);
    const conflictsWithSourceVersionIds = [...new Set(input.conflictsWithSourceVersionIds ?? [])];
    if (
      conflictsWithSourceVersionIds.some(
        (id) => !material.sourceVersions.some((source) => source.id === id),
      )
    ) {
      throw new LearningContentError('SOURCE_INVALID', '冲突来源必须属于这份学习资料');
    }
    const sourceKey = input.sourceKey
      ? requiredText(input.sourceKey, '来源身份')
      : `source:${randomUUID()}`;
    const priorVersions = material.sourceVersions.filter(
      (source) => source.sourceKey === sourceKey,
    );
    if (priorVersions.some((source) => source.kind !== input.kind)) {
      throw new LearningContentError('SOURCE_INVALID', '同一来源身份不能改变来源类型');
    }
    const sourceVersion: LearningSourceVersion = {
      conflictsWithSourceVersionIds,
      contentHash: checkedHash(input.contentHash),
      createdAt: this.#clock.now.toISOString(),
      createdBy: { ...input.actor },
      id: randomUUID(),
      kind: input.kind,
      label: requiredText(input.label, '来源名称'),
      sourceKey,
      sourceConfirmedContentVersionId: null,
      versionLabel: requiredText(input.versionLabel, '来源版本'),
      versionNumber: priorVersions.length + 1,
    };
    const saved = await this.#store.appendSourceVersion({
      expectedSourceCount: material.sourceVersions.length,
      expectedValidityEpoch: material.validityEpoch,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      sourceVersion,
    });
    if (!saved) {
      throw new LearningContentError('VERSION_CONFLICT', '学习来源已被其他操作更新，请刷新后重试');
    }
    material.sourceVersions.push(sourceVersion);
    return view(material);
  }

  async selectCurrentBasis(input: {
    actor: LearningActorReference;
    learningProfileId: string;
    materialId: string;
    reason: string;
    sourceVersionId: string;
  }): Promise<LearningMaterial> {
    const material = await this.#requireMaterial(input.materialId, input.learningProfileId);
    requireActive(material);
    if (view(material).basis.hasConflict && input.actor.type !== 'guardian') {
      throw new LearningContentError(
        'BASIS_SELECTION_REQUIRES_GUARDIAN',
        '学习依据存在争议，需要监护人重新选择或补充来源',
      );
    }
    if (!material.sourceVersions.some((source) => source.id === input.sourceVersionId)) {
      throw new LearningContentError('SOURCE_INVALID', '选择的学习依据不属于这份学习资料');
    }
    const selection: BasisSelectionVersion = {
      id: randomUUID(),
      reason: requiredText(input.reason, '选择原因'),
      selectedAt: this.#clock.now.toISOString(),
      selectedBy: { ...input.actor },
      sourceVersionId: input.sourceVersionId,
      version: material.basisSelectionHistory.length + 1,
    };
    const saved = await this.#store.appendBasisSelection({
      expectedSelectionRevision: material.basisSelectionHistory.length,
      expectedValidityEpoch: material.validityEpoch,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
      selection,
    });
    if (!saved) {
      throw new LearningContentError('VERSION_CONFLICT', '当前学习依据已变化，请刷新后重试');
    }
    material.basisSelectionHistory.push(selection);
    return view(material);
  }

  async #requireMaterial(id: string, learningProfileId: string): Promise<StoredLearningMaterial> {
    const material = await this.#store.findMaterial(id, learningProfileId);
    if (!material) {
      throw new LearningContentError('MATERIAL_NOT_FOUND', '没有找到这份学习资料');
    }
    return material;
  }
}
