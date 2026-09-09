import type { ObjectiveGradingRule, ResolvedObjectiveAssessmentInput } from './types.js';

export interface TrustedBuiltInRule {
  gradingRuleVersionId: string;
  rule: ObjectiveGradingRule;
}

export function deriveTrustedBuiltInRule(
  question: ResolvedObjectiveAssessmentInput['question'],
): TrustedBuiltInRule | null {
  if (question.subject !== 'mathematics') return null;
  const match = /^\s*(-?\d+)\s*([+\-×÷])\s*(-?\d+)\s*(?:=\s*(?:[?？])?)?\s*$/.exec(question.text);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2];
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
  const expected =
    operator === '+'
      ? left + right
      : operator === '-'
        ? left - right
        : operator === '×'
          ? left * right
          : right === 0
            ? null
            : left / right;
  if (expected === null || !Number.isFinite(expected)) return null;
  return {
    gradingRuleVersionId: 'builtin:integer-arithmetic:v1',
    rule: { expected: String(expected), kind: 'numeric' },
  };
}
