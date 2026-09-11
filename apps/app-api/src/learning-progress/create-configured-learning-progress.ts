import type { AssessmentService } from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';
import { LearningProgressService } from '@rhea/learning-progress';
import { createPostgresLearningProgressStore } from '@rhea/postgres-learning-progress';

import { createLocalLearningProgress } from './create-local-learning-progress.js';

export function createConfiguredLearningProgress(
  environment: Record<string, string | undefined>,
  assessment: AssessmentService,
  learningContent: LearningContentService,
) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production learning progress');
    }
    return {
      service: createLocalLearningProgress(assessment, learningContent),
      shutdownResources: [],
    };
  }
  const { pool, store } = createPostgresLearningProgressStore(environment.DATABASE_URL);
  return {
    service: new LearningProgressService({
      assessmentReader: assessment,
      learningContextReader: learningContent,
      store,
    }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
