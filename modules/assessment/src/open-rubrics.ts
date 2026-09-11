import type { Subject } from '@rhea/learning-content';

import rubricCatalogJson from '../assets/open-assessment-rubrics.v2.json' with { type: 'json' };
import type {
  OpenAssessmentAgeBand,
  OpenAssessmentRubricDimension,
  OpenAssessmentRubricSnapshot,
  OpenAssessmentTaskType,
} from './suggested-assessment.types.js';

interface OpenAssessmentRubricCatalog {
  sourceLabel: string;
  templates: Record<
    OpenAssessmentTaskType,
    { dimensions: OpenAssessmentRubricDimension[]; name: string; subject: Subject }
  >;
  version: string;
}

const rubricCatalog = rubricCatalogJson as OpenAssessmentRubricCatalog;

export function openAssessmentAgeBandForGrade(grade: number | null): OpenAssessmentAgeBand {
  if (grade === null || grade <= 2) return 'lower_primary';
  return grade <= 4 ? 'middle_primary' : 'upper_primary';
}

export function deriveProfessionallyReviewedOpenRubric(input: {
  ageBand: OpenAssessmentAgeBand;
  subject: Subject;
  taskType: OpenAssessmentTaskType;
}): OpenAssessmentRubricSnapshot | null {
  const template = rubricCatalog.templates[input.taskType];
  if (template.subject !== input.subject) return null;
  return {
    ageBand: input.ageBand,
    dimensions: structuredClone(template.dimensions),
    id: `rhea-${input.taskType}-${input.ageBand.replaceAll('_', '-')}`,
    name: template.name,
    source: {
      authority: 'rhea_professionally_reviewed',
      label: rubricCatalog.sourceLabel,
    },
    subject: input.subject,
    taskType: input.taskType,
    version: rubricCatalog.version,
  };
}
