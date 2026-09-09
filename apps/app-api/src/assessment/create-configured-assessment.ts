import { AssessmentService } from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';
import { createPostgresAssessmentStore } from '@rhea/postgres-assessment';

import { createLocalAssessment } from './create-local-assessment.js';

export function createConfiguredAssessment(
  environment: Record<string, string | undefined>,
  learningContent: LearningContentService,
) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production assessment');
    }
    return { service: createLocalAssessment(learningContent), shutdownResources: [] };
  }
  const { pool, store } = createPostgresAssessmentStore(environment.DATABASE_URL);
  return {
    service: new AssessmentService({ basisReader: learningContent, store }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
