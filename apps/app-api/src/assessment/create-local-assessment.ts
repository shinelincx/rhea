import { AssessmentService, MemoryAssessmentStore } from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';

export function createLocalAssessment(learningContent: LearningContentService): AssessmentService {
  return new AssessmentService({
    basisReader: learningContent,
    store: new MemoryAssessmentStore(),
  });
}
