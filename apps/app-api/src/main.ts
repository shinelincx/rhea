import { createApp } from './create-app.js';
import { createConfiguredFamilyAccess } from './family-access/create-configured-family-access.js';
import { createConfiguredJobClient } from './jobs/create-configured-job-client.js';
import { createConfiguredLearningContent } from './learning-content/create-configured-learning-content.js';
import { createConfiguredSubmission } from './submission/create-configured-submission.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

const configuredFamilyAccess = createConfiguredFamilyAccess(process.env);
const configuredSubmission = createConfiguredSubmission(process.env);
const configuredLearningContent = createConfiguredLearningContent(process.env);
const app = await createApp({
  familyAccess: configuredFamilyAccess.familyAccess,
  jobClient: createConfiguredJobClient(process.env),
  learningContentService: configuredLearningContent.service,
  shutdownResources: [
    ...configuredFamilyAccess.shutdownResources,
    ...configuredSubmission.shutdownResources,
    ...configuredLearningContent.shutdownResources,
  ],
  submissionScheduler: configuredSubmission.scheduler,
  submissionService: configuredSubmission.service,
});
await app.listen(port, host);
