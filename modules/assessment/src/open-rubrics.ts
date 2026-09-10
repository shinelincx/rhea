import type { Subject } from '@rhea/learning-content';

import type {
  OpenAssessmentAgeBand,
  OpenAssessmentRubricDimension,
  OpenAssessmentRubricSnapshot,
  OpenAssessmentTaskType,
} from './suggested-assessment.types.js';

const TEMPLATES: Record<
  OpenAssessmentTaskType,
  { dimensions: OpenAssessmentRubricDimension[]; name: string; subject: Subject }
> = {
  chinese_expression: {
    dimensions: [
      {
        description: '引用题目或材料中可核对的信息支持表达。',
        key: 'content_evidence',
        label: '内容证据',
        required: true,
      },
      {
        description: '句意完整，前后有顺序或联系。',
        key: 'expression',
        label: '表达组织',
        required: true,
      },
    ],
    name: '语文表达评分量规',
    subject: 'chinese',
  },
  english_expression: {
    dimensions: [
      {
        description: '围绕题目表达可理解的主要意思。',
        key: 'meaning',
        label: '意思表达',
        required: true,
      },
      {
        description: '使用与年龄层级相符的词句连接信息。',
        key: 'language_use',
        label: '语言运用',
        required: true,
      },
    ],
    name: '英语表达评分量规',
    subject: 'english',
  },
  mathematics_process: {
    dimensions: [
      {
        description: '呈现与题意相符的解题方法或步骤。',
        key: 'method',
        label: '方法',
        required: true,
      },
      {
        description: '说明关键步骤为什么成立。',
        key: 'reasoning',
        label: '推理',
        required: true,
      },
    ],
    name: '数学过程评分量规',
    subject: 'mathematics',
  },
  science_inquiry: {
    dimensions: [
      {
        description: '记录可观察、可核对的现象或变化。',
        key: 'observation',
        label: '观察记录',
        required: true,
      },
      {
        description: '用观察证据支持解释或结论。',
        key: 'evidence_reasoning',
        label: '证据推理',
        required: true,
      },
    ],
    name: '科学探究评分量规',
    subject: 'science',
  },
};

export function deriveProfessionallyReviewedOpenRubric(input: {
  ageBand: OpenAssessmentAgeBand;
  subject: Subject;
  taskType: OpenAssessmentTaskType;
}): OpenAssessmentRubricSnapshot | null {
  const template = TEMPLATES[input.taskType];
  if (template.subject !== input.subject) return null;
  return {
    ageBand: input.ageBand,
    dimensions: structuredClone(template.dimensions),
    id: `rhea-${input.taskType}-${input.ageBand.replaceAll('_', '-')}`,
    name: template.name,
    source: {
      authority: 'rhea_professionally_reviewed',
      label: 'Rhea 学科组审核模板',
    },
    subject: input.subject,
    taskType: input.taskType,
    version: '1.0.0',
  };
}
