import { AssessmentService, SuggestedAssessmentService } from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';
import { createPostgresAssessmentStore } from '@rhea/postgres-assessment';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';
import type { SubmissionService } from '@rhea/submission';

import { createLocalAssessment } from './create-local-assessment.js';
import { createLocalSuggestedAssessment } from './create-local-suggested-assessment.js';
import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';
import { unavailableOpenAssessmentModelGateway } from '@rhea/model-gateway-adapter';

export function createConfiguredAssessment(
  environment: Record<string, string | undefined>,
  learningContent: LearningContentService,
  submissions: SubmissionService,
  consentReader: AiProcessingConsentPublicationReader,
) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production assessment');
    }
    return {
      service: createLocalAssessment(learningContent, submissions),
      shutdownResources: [],
      suggestedService: createLocalSuggestedAssessment(learningContent, submissions, consentReader),
    };
  }
  const { pool, store, suggestedStore } = createPostgresAssessmentStore(environment.DATABASE_URL);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(pool));
  return {
    service: new AssessmentService({ basisReader: learningContent, inputReader: store, store }),
    shutdownResources: [{ close: () => pool.end() }],
    suggestedService: new SuggestedAssessmentService({
      basisReader: learningContent,
      inputReader: suggestedStore,
      modelGateway: unavailableOpenAssessmentModelGateway,
      publicationGate: suggestedStore,
      qualityControl,
      store: suggestedStore,
    }),
  };
}
