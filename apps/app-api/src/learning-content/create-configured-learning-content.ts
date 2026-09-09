import { LearningContentService } from '@rhea/learning-content';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';

import { createLocalLearningContent } from './create-local-learning-content.js';

export function createConfiguredLearningContent(environment: Record<string, string | undefined>) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production learning content');
    }
    return { service: createLocalLearningContent(), shutdownResources: [] };
  }
  const { pool, store } = createPostgresLearningContentStore(environment.DATABASE_URL);
  return {
    service: new LearningContentService({ store }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
