import type { Subject } from '@rhea/learning-content';
import {
  LearningProgressError,
  type MistakeReasonCategory,
  type MistakeReasonRevision,
  type WrongItemClassificationStatus,
} from '@rhea/learning-progress';

const SUBJECTS = new Set<Subject>(['chinese', 'mathematics', 'english', 'science']);
const CLASSIFICATION_STATUSES = new Set<WrongItemClassificationStatus>(['classified', 'pending']);
const REASON_ACTIONS = new Set<MistakeReasonRevision['action']>([
  'confirm',
  'mark_uncertain',
  'skip',
  'correct',
]);
const REASON_CATEGORIES = new Set<MistakeReasonCategory>([
  'knowledge',
  'step',
  'comprehension',
  'reading',
  'expression',
  'other',
]);

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LearningProgressError('INPUT_INVALID', `${label}必须是非空文本`);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label);
}

export function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringValue(value, label);
}

export function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new LearningProgressError('INPUT_INVALID', `${label}必须是文本列表`);
  }
  return value;
}

export function stateRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new LearningProgressError('INPUT_INVALID', '错题状态版本必须是正整数');
  }
  return value as number;
}

export function subject(value: unknown): Subject {
  const parsed = stringValue(value, '学科') as Subject;
  if (!SUBJECTS.has(parsed)) {
    throw new LearningProgressError('CLASSIFICATION_INVALID', '学科无效');
  }
  return parsed;
}

export function optionalSubject(value: unknown): Subject | undefined {
  return value === undefined ? undefined : subject(value);
}

export function classificationStatus(value: unknown): WrongItemClassificationStatus | undefined {
  if (value === undefined) return undefined;
  const parsed = stringValue(value, '归类状态') as WrongItemClassificationStatus;
  if (!CLASSIFICATION_STATUSES.has(parsed)) {
    throw new LearningProgressError('CLASSIFICATION_INVALID', '归类状态无效');
  }
  return parsed;
}

export function reasonAction(value: unknown): MistakeReasonRevision['action'] {
  const parsed = stringValue(value, '错因操作') as MistakeReasonRevision['action'];
  if (!REASON_ACTIONS.has(parsed)) {
    throw new LearningProgressError('REASON_REVISION_INVALID', '错因操作无效');
  }
  return parsed;
}

export function reasonCategory(value: unknown): MistakeReasonCategory {
  const parsed = stringValue(value, '错因类别') as MistakeReasonCategory;
  if (!REASON_CATEGORIES.has(parsed)) {
    throw new LearningProgressError('REASON_REVISION_INVALID', '错因类别无效');
  }
  return parsed;
}
