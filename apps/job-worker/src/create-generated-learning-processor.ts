import { GeneratedLearningService } from '@rhea/generated-learning';
import { LearningContentService } from '@rhea/learning-content';
import { unavailableModelGateway } from '@rhea/model-gateway-adapter';
import { createPostgresGeneratedLearningStore } from '@rhea/postgres-generated-learning';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';

import { createGeneratedLearningJobHandler } from './generated-learning-handler.js';

const WORKER_CAPABILITY = {
  adapterVersion: 'unconfigured',
  availability: 'unavailable',
  id: 'learning-pack-unavailable-v1',
  modelVersion: 'unconfigured',
  policyVersion: 'child-learning-policy-v1',
  region: 'cn-shanghai',
  templateVersion: 'lesson-support-template-v1',
} as const;

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
  const service = new GeneratedLearningService({
    basisReader: new LearningContentService({ store: learningContent.store }),
    capability: WORKER_CAPABILITY,
    modelGateway: unavailableModelGateway,
    publicationGate: generated.publicationGate,
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
