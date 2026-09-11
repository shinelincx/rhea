import {
  AssessmentError,
  type DimensionEvidenceState,
  type AssessmentCorrection,
  type ObjectiveAssessmentInputReference,
  type ObjectiveGradingRule,
  type OpenAssessmentReviewDecision,
  type OpenAssessmentTaskType,
} from '@rhea/assessment';

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssessmentError('INPUT_INVALID', `${label}格式不正确`);
  }
  return value as Record<string, unknown>;
}

const OPEN_TASK_TYPES = new Set<OpenAssessmentTaskType>([
  'chinese_expression',
  'mathematics_process',
  'english_expression',
  'science_inquiry',
]);

export function openAssessmentTaskType(value: unknown): OpenAssessmentTaskType {
  const taskType = stringValue(value, '开放题评价任务') as OpenAssessmentTaskType;
  if (!OPEN_TASK_TYPES.has(taskType)) {
    throw new AssessmentError('INPUT_INVALID', '暂不支持这种开放题评价任务');
  }
  return taskType;
}

export function openAssessmentReviewDecisions(value: unknown): OpenAssessmentReviewDecision[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw new AssessmentError('INPUT_INVALID', '请逐维提交 1 到 12 个复核决定');
  }
  return value.map((entry) => {
    const body = recordValue(entry, '评价维度决定');
    const action = stringValue(body.action, '复核动作');
    const dimensionKey = stringValue(body.dimensionKey, '评价维度');
    if (action === 'accept') return { action, dimensionKey };
    const reason = stringValue(body.reason, '复核原因');
    if (action === 'reject') return { action, dimensionKey, reason };
    if (action !== 'modify') {
      throw new AssessmentError('INPUT_INVALID', '复核动作必须是接受、修改或拒绝');
    }
    const modification = recordValue(body.modification, '修改后的维度结论');
    const state = stringValue(modification.state, '维度证据状态');
    if (
      ![
        'demonstrated',
        'partially_demonstrated',
        'not_demonstrated',
        'insufficient_evidence',
      ].includes(state)
    ) {
      throw new AssessmentError('INPUT_INVALID', '维度证据状态无效');
    }
    return {
      action,
      dimensionKey,
      modification: {
        evidenceExcerpt:
          modification.evidenceExcerpt === null
            ? null
            : stringValue(modification.evidenceExcerpt, '作答证据'),
        improvementSuggestion: stringValue(modification.improvementSuggestion, '改进建议'),
        observation: stringValue(modification.observation, '维度观察'),
        state: state as DimensionEvidenceState,
      },
      reason,
    } as OpenAssessmentReviewDecision;
  });
}

export function stateRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new AssessmentError('INPUT_INVALID', '状态版本必须是正整数');
  }
  return value as number;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AssessmentError('INPUT_INVALID', `${label}必须是文本`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AssessmentError('INPUT_INVALID', `${label}必须是布尔值`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AssessmentError('INPUT_INVALID', `${label}必须是文本列表`);
  }
  return value;
}

export function assessmentInputReference(value: unknown): ObjectiveAssessmentInputReference {
  const body = recordValue(value, '已确认批改输入');
  return {
    confirmedContentVersionId: stringValue(body.confirmedContentVersionId, '已确认内容版本'),
    processingJobId: stringValue(body.processingJobId, '识别任务'),
    questionRegionId: stringValue(body.questionRegionId, '题目区域'),
    responseRegionId: stringValue(body.responseRegionId, '作答区域'),
  };
}

export function objectiveGradingRule(value: unknown): ObjectiveGradingRule {
  const body = recordValue(value, '评价规则');
  const kind = stringValue(body.kind, '评价规则类型');
  if (kind === 'numeric') {
    return { expected: stringValue(body.expected, '预期答案'), kind };
  }
  if (kind === 'accepted_text') {
    return {
      acceptedAnswers: stringArray(body.acceptedAnswers, '可接受答案'),
      caseSensitive: booleanValue(body.caseSensitive, '是否区分大小写'),
      collapseWhitespace: booleanValue(body.collapseWhitespace, '是否归一化空格'),
      kind,
    };
  }
  if (kind === 'single_choice') {
    return { correctOption: stringValue(body.correctOption, '正确选项'), kind };
  }
  throw new AssessmentError('INPUT_INVALID', '暂不支持这种客观评价规则');
}

export function assessmentCorrection(value: unknown): AssessmentCorrection {
  const body = recordValue(value, '复核修正');
  return {
    ...(body.questionText === undefined
      ? {}
      : { questionText: stringValue(body.questionText, '修正题目') }),
    ...(body.responseText === undefined
      ? {}
      : { responseText: stringValue(body.responseText, '修正作答') }),
    ...(Object.prototype.hasOwnProperty.call(body, 'rule')
      ? { rule: body.rule === null ? null : objectiveGradingRule(body.rule) }
      : {}),
  };
}
