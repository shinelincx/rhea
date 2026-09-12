import { createApp } from './create-app.js';
import { createConfiguredFamilyAccess } from './family-access/create-configured-family-access.js';
import { createConfiguredAssessment } from './assessment/create-configured-assessment.js';
import { createQueuedSuggestedAssessmentScheduler } from './assessment/create-queued-suggested-assessment-scheduler.js';
import {
  createConfiguredAiJobClient,
  createConfiguredJobClient,
} from './jobs/create-configured-job-client.js';
import { createConfiguredLearningContent } from './learning-content/create-configured-learning-content.js';
import { createConfiguredSubmission } from './submission/create-configured-submission.js';
import { createQueuedGeneratedLearningScheduler } from './generated-learning/create-queued-generated-learning-scheduler.js';
import { createConfiguredGeneratedLearning } from './generated-learning/create-configured-generated-learning.js';
import { createConfiguredLearningProgress } from './learning-progress/create-configured-learning-progress.js';
import { createQueuedReviewCardScheduler } from './learning-progress/create-queued-review-card-scheduler.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

const configuredFamilyAccess = createConfiguredFamilyAccess(process.env);
const configuredSubmission = createConfiguredSubmission(process.env);
const configuredLearningContent = createConfiguredLearningContent(process.env);
const configuredAssessment = createConfiguredAssessment(
  process.env,
  configuredLearningContent.service,
  configuredSubmission.service,
  configuredFamilyAccess.familyAccess,
);
const configuredGeneratedLearning = createConfiguredGeneratedLearning(
  process.env,
  configuredLearningContent.service,
  configuredFamilyAccess.familyAccess,
);
const configuredLearningProgress = createConfiguredLearningProgress(
  process.env,
  configuredAssessment.service,
  configuredLearningContent.service,
  configuredFamilyAccess.familyAccess,
);
const aiJobClient = createConfiguredAiJobClient(process.env);
const closeableAiJobClient = aiJobClient as unknown as { close?: () => Promise<void> };
const app = await createApp({
  assessmentService: configuredAssessment.service,
  suggestedAssessmentService: configuredAssessment.suggestedService,
  suggestedAssessmentScheduler: createQueuedSuggestedAssessmentScheduler(aiJobClient),
  familyAccess: configuredFamilyAccess.familyAccess,
  generatedLearningConsentReader: configuredFamilyAccess.familyAccess,
  generatedLearningScheduler: createQueuedGeneratedLearningScheduler(aiJobClient),
  generatedLearningService: configuredGeneratedLearning.service,
  jobClient: createConfiguredJobClient(process.env),
  learningContentService: configuredLearningContent.service,
  learningProgressService: configuredLearningProgress.service,
  reviewCardScheduler: createQueuedReviewCardScheduler(aiJobClient),
  reviewCardService: configuredLearningProgress.reviewCardService,
  shutdownResources: [
    ...configuredFamilyAccess.shutdownResources,
    ...configuredSubmission.shutdownResources,
    ...configuredLearningContent.shutdownResources,
    ...configuredAssessment.shutdownResources,
    ...configuredGeneratedLearning.shutdownResources,
    ...configuredLearningProgress.shutdownResources,
    ...(typeof closeableAiJobClient.close === 'function'
      ? [{ close: () => closeableAiJobClient.close!() }]
      : []),
  ],
  submissionScheduler: configuredSubmission.scheduler,
  submissionService: configuredSubmission.service,
});
await app.listen(port, host);
