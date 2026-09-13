import { SuggestedAssessmentService } from '@rhea/assessment';
import { LearningContentService } from '@rhea/learning-content';
import { unavailableOpenAssessmentModelGateway } from '@rhea/model-gateway-adapter';
import { GovernedHttpClient, MainlandOpenAssessmentGateway } from '@rhea/china-provider-adapters';
import type { ProviderGovernanceService } from '@rhea/provider-governance';
import type { SafetyEscalationService } from '@rhea/safety-escalation';
import { createPostgresAssessmentStore } from '@rhea/postgres-assessment';
import { createPostgresLearningContentStore } from '@rhea/postgres-learning-content';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

import { createOpenAssessmentJobHandler } from './open-assessment-handler.js';

export function createConfiguredOpenAssessmentProcessor(
  environment: Record<string, string | undefined>,
  governance?: ProviderGovernanceService,
  safety?: SafetyEscalationService,
): {
  handler: ReturnType<typeof createOpenAssessmentJobHandler> | undefined;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) return { handler: undefined, shutdownResources: [] };
  const modelGateway =
    governance &&
    safety &&
    environment.MODEL_GATEWAY_URL &&
    environment.MODEL_GATEWAY_TOKEN &&
    environment.MODEL_GATEWAY_CAPABILITY_VERSION_ID
      ? new MainlandOpenAssessmentGateway(
          new GovernedHttpClient({
            authorizationToken: environment.MODEL_GATEWAY_TOKEN,
            capabilityVersionId: environment.MODEL_GATEWAY_CAPABILITY_VERSION_ID,
            dataCategories: ['confirmed_structured_learning_data'],
            governance,
            purpose: 'open_assessment',
            url: environment.MODEL_GATEWAY_URL,
          }),
          safety,
        )
      : unavailableOpenAssessmentModelGateway;
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
