import {
  AssessmentError,
  type AssessmentCorrection,
  type ObjectiveAssessmentInputReference,
  type ObjectiveGradingRule,
} from '@rhea/assessment';

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssessmentError('INPUT_INVALID', `${label}格式不正确`);
  }
  return value as Record<string, unknown>;
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
