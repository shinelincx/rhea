import { createHash, randomUUID } from 'node:crypto';

import { LearningContentError } from './error.js';
import type { LearningContentStore } from './store.js';
import type {
  BasisSelectionVersion,
  ClassificationDraft,
  ClassificationVersion,
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
    (coursePathName || unitName || knowledgePointNames.length || primaryKnowledgePointName)
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
          id: stableId('knowledge-point', learningProfileId, primarySubject, name.toLowerCase()),
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
  const conflictingSourceVersionIds = material.sourceVersions
    .filter((source) => source.id !== current.id && source.contentHash !== current.contentHash)
    .map((source) => source.id);
  return {
    ...structuredClone(material),
    basis: {
      conflictingSourceVersionIds,
      currentSourceVersionId: current.id,
      hasConflict: conflictingSourceVersionIds.length > 0,
      selectionRevision: currentSelection.version,
    },
    currentClassification: structuredClone(currentClassification),
  };
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
      contentHash: checkedHash(input.sourceHash),
      createdAt,
      createdBy: { ...input.actor },
      id: randomUUID(),
      kind: 'learning_material',
      label: '已确认学习资料',
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
      learningProfileId: requiredText(input.learningProfileId, '学习档案'),
      sourceHash: sourceVersion.contentHash,
      sourceVersions: [sourceVersion],
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
    return view(material);
  }

  async getMaterial(input: {
    learningProfileId: string;
    materialId: string;
  }): Promise<LearningMaterial> {
    return view(await this.#requireMaterial(input.materialId, input.learningProfileId));
  }

  async correctClassification(input: {
    actor: LearningActorReference;
    classification: ClassificationDraft;
    learningProfileId: string;
    materialId: string;
    reason: string;
  }): Promise<LearningMaterial> {
    const material = await this.#requireMaterial(input.materialId, input.learningProfileId);
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
    contentHash: string;
    kind: LearningSourceKind;
    label: string;
    learningProfileId: string;
    materialId: string;
    versionLabel: string;
  }): Promise<LearningMaterial> {
    if (!SOURCE_KINDS.has(input.kind) || input.kind === 'learning_material') {
      throw new LearningContentError('SOURCE_INVALID', '补充来源必须是题目、答案或评分依据');
    }
    const material = await this.#requireMaterial(input.materialId, input.learningProfileId);
    const sourceVersion: LearningSourceVersion = {
      contentHash: checkedHash(input.contentHash),
      createdAt: this.#clock.now.toISOString(),
      createdBy: { ...input.actor },
      id: randomUUID(),
      kind: input.kind,
      label: requiredText(input.label, '来源名称'),
      sourceConfirmedContentVersionId: null,
      versionLabel: requiredText(input.versionLabel, '来源版本'),
      versionNumber:
        material.sourceVersions.filter((source) => source.kind === input.kind).length + 1,
    };
    const saved = await this.#store.appendSourceVersion({
      expectedSourceCount: material.sourceVersions.length,
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
