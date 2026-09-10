import { createApp } from './create-app.js';
import { createConfiguredFamilyAccess } from './family-access/create-configured-family-access.js';
import { createConfiguredAssessment } from './assessment/create-configured-assessment.js';
import {
  createConfiguredAiJobClient,
  createConfiguredJobClient,
} from './jobs/create-configured-job-client.js';
import { createConfiguredLearningContent } from './learning-content/create-configured-learning-content.js';
import { createConfiguredSubmission } from './submission/create-configured-submission.js';
import { createQueuedGeneratedLearningScheduler } from './generated-learning/create-queued-generated-learning-scheduler.js';
import { createConfiguredGeneratedLearning } from './generated-learning/create-configured-generated-learning.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

const configuredFamilyAccess = createConfiguredFamilyAccess(process.env);
const configuredSubmission = createConfiguredSubmission(process.env);
const configuredLearningContent = createConfiguredLearningContent(process.env);
const configuredAssessment = createConfiguredAssessment(
  process.env,
  configuredLearningContent.service,
  configuredSubmission.service,
);
const configuredGeneratedLearning = createConfiguredGeneratedLearning(
  process.env,
  configuredLearningContent.service,
  configuredFamilyAccess.familyAccess,
);
const aiJobClient = createConfiguredAiJobClient(process.env);
const closeableAiJobClient = aiJobClient as unknown as { close?: () => Promise<void> };
const app = await createApp({
  assessmentService: configuredAssessment.service,
  familyAccess: configuredFamilyAccess.familyAccess,
  generatedLearningConsentReader: configuredFamilyAccess.familyAccess,
  generatedLearningScheduler: createQueuedGeneratedLearningScheduler(aiJobClient),
  generatedLearningService: configuredGeneratedLearning.service,
  jobClient: createConfiguredJobClient(process.env),
  learningContentService: configuredLearningContent.service,
  shutdownResources: [
    ...configuredFamilyAccess.shutdownResources,
    ...configuredSubmission.shutdownResources,
    ...configuredLearningContent.shutdownResources,
    ...configuredAssessment.shutdownResources,
    ...configuredGeneratedLearning.shutdownResources,
    ...(typeof closeableAiJobClient.close === 'function'
      ? [{ close: () => closeableAiJobClient.close!() }]
      : []),
  ],
  submissionScheduler: configuredSubmission.scheduler,
  submissionService: configuredSubmission.service,
});
await app.listen(port, host);
