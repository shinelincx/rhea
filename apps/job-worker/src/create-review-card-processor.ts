import { AssessmentService } from '@rhea/assessment';
import { LearningContentService } from '@rhea/learning-content';
import { ReviewCardService } from '@rhea/learning-progress';
import { unavailableReviewCardModelGateway } from '@rhea/model-gateway-adapter';
import { GovernedHttpClient, MainlandReviewCardGateway } from '@rhea/china-provider-adapters';
import type { ProviderGovernanceService } from '@rhea/provider-governance';
import type { SafetyEscalationService } from '@rhea/safety-escalation';
import { createPostgresAssessmentStore } from '@rhea/postgres-assessment';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { createPostgresLearningProgressStore } from '@rhea/postgres-learning-progress';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

import { createReviewCardJobHandler } from './review-card-handler.js';

export function createConfiguredReviewCardProcessor(
  environment: Record<string, string | undefined>,
  governance?: ProviderGovernanceService,
  safety?: SafetyEscalationService,
): {
  handler: ReturnType<typeof createReviewCardJobHandler> | undefined;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) return { handler: undefined, shutdownResources: [] };
  const progress = createPostgresLearningProgressStore(databaseUrl);
  const assessment = createPostgresAssessmentStore(databaseUrl);
  const learningContent = createPostgresLearningContentStore(databaseUrl);
  const learningContentService = new LearningContentService({ store: learningContent.store });
  const assessmentService = new AssessmentService({
    basisReader: learningContentService,
    inputReader: assessment.store,
    store: assessment.store,
  });
  const service = new ReviewCardService({
    assessmentReader: assessmentService,
    modelGateway:
      governance &&
      safety &&
      environment.MODEL_GATEWAY_URL &&
      environment.MODEL_GATEWAY_TOKEN &&
      environment.MODEL_GATEWAY_CAPABILITY_VERSION_ID
        ? new MainlandReviewCardGateway(
            new GovernedHttpClient({
              authorizationToken: environment.MODEL_GATEWAY_TOKEN,
              capabilityVersionId: environment.MODEL_GATEWAY_CAPABILITY_VERSION_ID,
              dataCategories: ['confirmed_structured_learning_data'],
              governance,
              purpose: 'review_card',
              url: environment.MODEL_GATEWAY_URL,
            }),
            safety,
          )
        : unavailableReviewCardModelGateway,
    publicationGate: progress.publicationGate,
    qualityControl: new QualityControlService(new PostgresQualityControlStore(progress.pool)),
    reviewCardStore: progress.reviewCardStore,
    wrongItemStore: progress.store,
  });
  return {
    handler: createReviewCardJobHandler(service),
    shutdownResources: [
      { close: () => progress.pool.end() },
      { close: () => assessment.pool.end() },
      { close: () => learningContent.pool.end() },
    ],
  };
}
