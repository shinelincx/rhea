import { GeneratedLearningService } from '@rhea/generated-learning';
import { LearningContentService } from '@rhea/learning-content';
import { unavailableModelGateway } from '@rhea/model-gateway-adapter';
import {
  GovernedHttpClient,
  MainlandGeneratedLearningGateway,
} from '@rhea/china-provider-adapters';
import type { ProviderGovernanceService } from '@rhea/provider-governance';
import type { SafetyEscalationService } from '@rhea/safety-escalation';
import { createPostgresGeneratedLearningStore } from '@rhea/postgres-generated-learning';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

import { createGeneratedLearningJobHandler } from './generated-learning-handler.js';

export function createConfiguredGeneratedLearningProcessor(
  environment: Record<string, string | undefined>,
  governance?: ProviderGovernanceService,
  safety?: SafetyEscalationService,
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
    modelGateway:
      governance &&
      safety &&
      environment.MODEL_GATEWAY_URL &&
      environment.MODEL_GATEWAY_TOKEN &&
      environment.MODEL_GATEWAY_CAPABILITY_VERSION_ID
        ? new MainlandGeneratedLearningGateway(
            new GovernedHttpClient({
              authorizationToken: environment.MODEL_GATEWAY_TOKEN,
              capabilityVersionId: environment.MODEL_GATEWAY_CAPABILITY_VERSION_ID,
              dataCategories: ['confirmed_structured_learning_data'],
              governance,
              purpose: 'generated_learning',
              url: environment.MODEL_GATEWAY_URL,
            }),
            safety,
          )
        : unavailableModelGateway,
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
