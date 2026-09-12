import type { AssessmentService } from '@rhea/assessment';
import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';
import type { LearningContentService } from '@rhea/learning-content';
import { LearningProgressService, ReviewCardService } from '@rhea/learning-progress';
import { unavailableReviewCardModelGateway } from '@rhea/model-gateway-adapter';
import { createPostgresLearningProgressStore } from '@rhea/postgres-learning-progress';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

import { createLocalLearningProgressBundle } from './create-local-learning-progress.js';

export function createConfiguredLearningProgress(
  environment: Record<string, string | undefined>,
  assessment: AssessmentService,
  learningContent: LearningContentService,
  consentReader: AiProcessingConsentPublicationReader,
) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production learning progress');
    }
    return {
      ...createLocalLearningProgressBundle(assessment, learningContent, consentReader),
      shutdownResources: [],
    };
  }
  const { pool, publicationGate, reviewCardStore, store } = createPostgresLearningProgressStore(
    environment.DATABASE_URL,
  );
  return {
    reviewCardService: new ReviewCardService({
      assessmentReader: assessment,
      modelGateway: unavailableReviewCardModelGateway,
      publicationGate,
      qualityControl: new QualityControlService(new PostgresQualityControlStore(pool)),
      reviewCardStore,
      wrongItemStore: store,
    }),
    service: new LearningProgressService({
      assessmentReader: assessment,
      learningContextReader: learningContent,
      store,
    }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
