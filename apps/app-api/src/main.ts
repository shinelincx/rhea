import { createApp } from './create-app.js';
import { createConfiguredFamilyAccess } from './family-access/create-configured-family-access.js';
import { createConfiguredAssessment } from './assessment/create-configured-assessment.js';
import {
  createConfiguredJobClient,
  createConfiguredSafetyJobClient,
} from './jobs/create-configured-job-client.js';
import { createConfiguredLearningContent } from './learning-content/create-configured-learning-content.js';
import { createConfiguredSubmission } from './submission/create-configured-submission.js';
import { createConfiguredGeneratedLearning } from './generated-learning/create-configured-generated-learning.js';
import { createConfiguredLearningProgress } from './learning-progress/create-configured-learning-progress.js';
import { createConfiguredReporting } from './reporting/create-configured-reporting.js';
import type { ChallengeAuthorizationPort } from '@rhea/challenge';
import { createConfiguredChallenge } from './challenge/create-configured-challenge.js';
import { createConfiguredSafety } from './safety/create-configured-safety.js';
import { createConfiguredPrivacy } from './privacy/create-configured-privacy.js';
import { createQueuedPrivacyTaskScheduler } from './privacy/create-queued-privacy-task-scheduler.js';
import { createConfiguredProviderGovernance } from './provider-governance/create-configured-provider-governance.js';
import { createPostgresSupportDataReader } from './safety/support-data.provider.js';
import { createConfiguredOperations } from './operations/create-configured-operations.js';
import { validateProductionOperationsCredentials } from './operations/operations-auth.js';
import { validateProductionTransportSecurity } from '@rhea/job-runtime';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';
validateProductionTransportSecurity(process.env);
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.SUPPORT_PRINCIPAL_TOKENS || !process.env.SUPPORT_DATABASE_URL)
) {
  throw new Error('SUPPORT_PRINCIPAL_TOKENS and SUPPORT_DATABASE_URL are required in production');
}
if (process.env.NODE_ENV === 'production') {
  validateProductionOperationsCredentials(process.env);
}
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.OPERATIONS_PRINCIPAL_TOKENS ||
    !process.env.OPERATIONS_PRINCIPAL_ROLES ||
    !process.env.OPERATIONS_DATABASE_URL)
) {
  throw new Error(
    'OPERATIONS_PRINCIPAL_TOKENS, OPERATIONS_PRINCIPAL_ROLES and OPERATIONS_DATABASE_URL are required in production',
  );
}

const configuredProviderGovernance = createConfiguredProviderGovernance(process.env);
const configuredFamilyAccess = createConfiguredFamilyAccess(
  process.env,
  configuredProviderGovernance.service,
);
const configuredSubmission = createConfiguredSubmission(
  process.env,
  configuredProviderGovernance.service,
);
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
const safetyJobClient = createConfiguredSafetyJobClient(process.env);
const configuredReporting = createConfiguredReporting(process.env);
const challengeAuthorization: ChallengeAuthorizationPort = {
  getChallengeAuthorization: (actor) =>
    configuredFamilyAccess.familyAccess.getChallengeAuthorizationSnapshot(actor),
};
const configuredChallenge = createConfiguredChallenge(process.env, challengeAuthorization);
const configuredSafety = createConfiguredSafety(process.env);
const configuredOperations = createConfiguredOperations(process.env, configuredSafety.service);
const supportDatabaseUrl = process.env.SUPPORT_DATABASE_URL ?? process.env.DATABASE_URL;
const configuredSupportData = supportDatabaseUrl
  ? createPostgresSupportDataReader(supportDatabaseUrl)
  : null;
const configuredPrivacy = createConfiguredPrivacy(process.env);
const closeableSafetyJobClient = safetyJobClient as unknown as { close?: () => Promise<void> };
const outboxOwnedScheduler = { async schedule() {} };
const app = await createApp({
  assessmentService: configuredAssessment.service,
  challengeService: configuredChallenge.service,
  suggestedAssessmentService: configuredAssessment.suggestedService,
  suggestedAssessmentScheduler: outboxOwnedScheduler,
  familyAccess: configuredFamilyAccess.familyAccess,
  generatedLearningConsentReader: configuredFamilyAccess.familyAccess,
  generatedLearningScheduler: outboxOwnedScheduler,
  generatedLearningService: configuredGeneratedLearning.service,
  gamificationService: configuredLearningProgress.gamificationService,
  jobClient: createConfiguredJobClient(process.env),
  learningContentService: configuredLearningContent.service,
  learningProgressService: configuredLearningProgress.service,
  ...(configuredOperations.metrics
    ? { metricsGovernanceService: configuredOperations.metrics }
    : {}),
  qualityControlOperationsService: configuredOperations.quality,
  reviewCardScheduler: outboxOwnedScheduler,
  reviewCardService: configuredLearningProgress.reviewCardService,
  reportingService: configuredReporting.service,
  safetyEscalationService: configuredSafety.service,
  safetyOperationsService: configuredOperations.safety,
  ...(configuredSupportData ? { supportDataReader: configuredSupportData.reader } : {}),
  privacyLifecycleService: configuredPrivacy.service,
  privacyTaskScheduler: createQueuedPrivacyTaskScheduler(safetyJobClient),
  shutdownResources: [
    ...configuredFamilyAccess.shutdownResources,
    ...configuredSubmission.shutdownResources,
    ...configuredLearningContent.shutdownResources,
    ...configuredAssessment.shutdownResources,
    ...configuredGeneratedLearning.shutdownResources,
    ...configuredLearningProgress.shutdownResources,
    ...configuredReporting.shutdownResources,
    ...configuredChallenge.shutdownResources,
    ...configuredSafety.shutdownResources,
    ...configuredOperations.shutdownResources,
    ...(configuredSupportData ? [{ close: () => configuredSupportData.pool.end() }] : []),
    ...configuredPrivacy.shutdownResources,
    ...configuredProviderGovernance.shutdownResources,
    ...(typeof closeableSafetyJobClient.close === 'function'
      ? [{ close: () => closeableSafetyJobClient.close!() }]
      : []),
  ],
  submissionScheduler: configuredSubmission.scheduler,
  submissionService: configuredSubmission.service,
});
await app.listen(port, host);
