import {
  LearningProgressService,
  MemoryLearningProgressStore,
  MemoryReviewCardStore,
  ReviewCardService,
  type ReviewCardModelGatewayPort,
} from '@rhea/learning-progress';
import type { AssessmentService } from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';
import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';

import { createLocalCapabilityAuthorization } from '../quality-control/local-capability-authorization.js';

function ageBandForGrade(grade: number | null) {
  if (grade === null || grade <= 2) return 'lower_primary';
  return grade <= 4 ? 'middle_primary' : 'upper_primary';
}

export function createLocalLearningProgressBundle(
  assessment: AssessmentService,
  learningContent: LearningContentService,
  consentReader: AiProcessingConsentPublicationReader,
) {
  const wrongItemStore = new MemoryLearningProgressStore();
  const reviewCardStore = new MemoryReviewCardStore(wrongItemStore.mastery);
  const service = new LearningProgressService({
    assessmentReader: assessment,
    learningContextReader: learningContent,
    store: wrongItemStore,
  });
  const modelGateway: ReviewCardModelGatewayPort = {
    async runStructured() {
      throw new Error('MODEL_CAPABILITY_UNAVAILABLE');
    },
  };
  const reviewCardService = new ReviewCardService({
    assessmentReader: assessment,
    modelGateway,
    publicationGate: {
      async authorize(input) {
        const consent = await consentReader.getAiProcessingConsentSnapshotForPublication({
          familySpaceId: input.familySpaceId,
          learningProfileId: input.learningProfileId,
        });
        return (
          consent?.status === 'granted' &&
          consent.revision === input.consentRevision &&
          ageBandForGrade(consent.grade) === input.ageBand
        );
      },
    },
    qualityControl: createLocalCapabilityAuthorization(null),
    reviewCardStore,
    wrongItemStore,
  });
  return { reviewCardService, service };
}

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
