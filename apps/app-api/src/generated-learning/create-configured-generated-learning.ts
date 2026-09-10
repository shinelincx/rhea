import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';
import { GeneratedLearningService, type ModelGatewayPort } from '@rhea/generated-learning';
import type { LearningContentService } from '@rhea/learning-content';
import { createPostgresGeneratedLearningStore } from '@rhea/postgres-generated-learning';

import {
  createLocalGeneratedLearning,
  UNAVAILABLE_GENERATED_LEARNING_CAPABILITY,
} from './create-local-generated-learning.js';
import type { GeneratedLearningScheduler } from './generated-learning.provider.js';

const unavailableModelGateway: ModelGatewayPort = {
  async runStructured() {
    throw new Error('MODEL_CAPABILITY_UNAVAILABLE');
  },
};

export function createConfiguredGeneratedLearning(
  environment: Record<string, string | undefined>,
  learningContent: LearningContentService,
  consentReader: AiProcessingConsentPublicationReader,
): {
  localScheduler: GeneratedLearningScheduler;
  service: GeneratedLearningService;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production generated learning');
    }
    const local = createLocalGeneratedLearning(learningContent, consentReader);
    return { localScheduler: local.scheduler, service: local.service, shutdownResources: [] };
  }
  const { pool, publicationGate, store } = createPostgresGeneratedLearningStore(databaseUrl);
  return {
    localScheduler: {
      async schedule() {
        throw new Error('Persistent generated learning must use the AI queue');
      },
    },
    service: new GeneratedLearningService({
      basisReader: learningContent,
      capability: UNAVAILABLE_GENERATED_LEARNING_CAPABILITY,
      modelGateway: unavailableModelGateway,
      publicationGate,
      store,
    }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
