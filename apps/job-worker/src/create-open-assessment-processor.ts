import { SuggestedAssessmentService } from '@rhea/assessment';
import { LearningContentService } from '@rhea/learning-content';
import { createConfiguredOpenAssessmentModelGateway } from '@rhea/model-gateway-adapter';
import { createPostgresAssessmentStore } from '@rhea/postgres-assessment';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

import { createOpenAssessmentJobHandler } from './open-assessment-handler.js';

export function createConfiguredOpenAssessmentProcessor(
  environment: Record<string, string | undefined>,
): {
  handler: ReturnType<typeof createOpenAssessmentJobHandler> | undefined;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) return { handler: undefined, shutdownResources: [] };
  const modelGateway = createConfiguredOpenAssessmentModelGateway(environment);
  const assessment = createPostgresAssessmentStore(databaseUrl);
  const learning = createPostgresLearningContentStore(databaseUrl);
  const service = new SuggestedAssessmentService({
    basisReader: new LearningContentService({ store: learning.store }),
    inputReader: assessment.suggestedStore,
    modelGateway,
    publicationGate: assessment.suggestedStore,
    qualityControl: new QualityControlService(new PostgresQualityControlStore(assessment.pool)),
    store: assessment.suggestedStore,
  });
  return {
    handler: createOpenAssessmentJobHandler(service),
    shutdownResources: [
      { close: () => assessment.pool.end() },
      { close: () => learning.pool.end() },
    ],
  };
}
