import { LearningProgressService, MemoryLearningProgressStore } from '@rhea/learning-progress';
import type { AssessmentService } from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';

export function createLocalLearningProgress(
  assessment: AssessmentService,
  learningContent: LearningContentService,
): LearningProgressService {
  return new LearningProgressService({
    assessmentReader: assessment,
    learningContextReader: learningContent,
    store: new MemoryLearningProgressStore(),
  });
}
