import { LearningContentService, MemoryLearningContentStore } from '@rhea/learning-content';

export function createLocalLearningContent(): LearningContentService {
  return new LearningContentService({ store: new MemoryLearningContentStore() });
}
