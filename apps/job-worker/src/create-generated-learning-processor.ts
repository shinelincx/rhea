import { GeneratedLearningService } from '@rhea/generated-learning';
import { LearningContentService } from '@rhea/learning-content';
import { unavailableModelGateway } from '@rhea/model-gateway-adapter';
import { createPostgresGeneratedLearningStore } from '@rhea/postgres-generated-learning';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

import { createGeneratedLearningJobHandler } from './generated-learning-handler.js';

export function createConfiguredGeneratedLearningProcessor(
  environment: Record<string, string | undefined>,
): {
  handler: ReturnType<typeof createGeneratedLearningJobHandler> | undefined;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) return { handler: undefined, shutdownResources: [] };

  const generated = createPostgresGeneratedLearningStore(databaseUrl);
  const learningContent = createPostgresLearningContentStore(databaseUrl);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(generated.pool));
  const service = new GeneratedLearningService({
    basisReader: new LearningContentService({ store: learningContent.store }),
    modelGateway: unavailableModelGateway,
    publicationGate: generated.publicationGate,
    qualityControl,
    store: generated.store,
  });
  return {
    handler: createGeneratedLearningJobHandler(service),
    shutdownResources: [
      { close: () => generated.pool.end() },
      { close: () => learningContent.pool.end() },
    ],
  };
}
