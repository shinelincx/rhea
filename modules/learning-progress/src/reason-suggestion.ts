import type { AcceptedObjectiveAssessmentSnapshot } from '@rhea/assessment';

import type { MistakeReasonSuggestionProvider } from './ports.js';
import type { MistakeReasonCandidate, MistakeReasonCategory } from './types.js';

const DISCLOSURE =
  '这是根据当前题目、作答和正确依据提出的可能错因，不是对学习者的事实判断。' as const;

function excerpt(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}…`;
}

function category(input: AcceptedObjectiveAssessmentSnapshot): MistakeReasonCategory {
  if (input.question.subject === 'mathematics') return 'step';
  if (input.question.subject === 'chinese') return 'reading';
  if (input.question.subject === 'english') return 'expression';
  if (input.question.subject === 'science') return 'knowledge';
  return 'other';
}

export const conservativeMistakeReasonSuggestionProvider: MistakeReasonSuggestionProvider = {
  async suggest(input): Promise<MistakeReasonCandidate> {
    const suggestedCategory = category(input);
    return {
      category: suggestedCategory,
      evidence: {
        expectedExcerpt: excerpt(input.correctBasis.expectedDisplay),
        questionExcerpt: excerpt(input.question.text),
        responseExcerpt: excerpt(input.response.text),
      },
      explanation:
        suggestedCategory === 'step'
          ? '可能需要检查从题意到关键计算步骤之间是否有遗漏或不一致。'
          : '可能需要对照题目要求与正确依据，找出当前作答中尚未覆盖的关键信息。',
      hypothesisDisclosure: DISCLOSURE,
      provider: { kind: 'deterministic_seed', version: 'conservative-v1' },
    };
  },
};
