import process from 'node:process';

import { parseWorkerConfig } from './config.js';
import { createRoleWorker } from './worker.js';
import { createConfiguredGeneratedLearningProcessor } from './create-generated-learning-processor.js';
import { createConfiguredOpenAssessmentProcessor } from './create-open-assessment-processor.js';
import { createConfiguredReviewCardProcessor } from './create-review-card-processor.js';
import { createWorkerProviderGovernance } from './create-provider-governance.js';
import { startOutboxRelay } from './outbox-relay.js';
import { createConfiguredPrivacyProcessor } from './create-privacy-processor.js';
import { createWorkerSafetyEscalation } from './create-safety-escalation.js';
import { createPostgresDomainEventProjector } from './domain-event-projector.js';
import { createConfiguredSubmissionProcessor } from './create-submission-processor.js';
import { startChallengeReportClassifier } from './challenge-report-classifier.js';

const config = parseWorkerConfig(process.env, process.argv[2]);
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error(`DATABASE_URL is required for the production ${config.role} worker`);
}
const providerGovernance = createWorkerProviderGovernance(process.env);
const safetyEscalation = createWorkerSafetyEscalation(
  process.env,
  config.role === 'safety' ? 'worker' : config.role === 'ai' ? 'classifier' : 'disabled',
);
const challengeReportClassifier =
  config.role === 'safety'
    ? startChallengeReportClassifier(safetyEscalation.processChallengeReportClassifications)
    : null;
if (
  config.role === 'domain' &&
  process.env.NODE_ENV === 'production' &&
  !process.env.METRICS_TOKEN_PEPPER
) {
  throw new Error('METRICS_TOKEN_PEPPER is required for the production domain worker');
}
const domainProjector =
  config.role === 'domain' && process.env.DATABASE_URL
    ? createPostgresDomainEventProjector(
        process.env.DATABASE_URL,
        process.env.METRICS_TOKEN_PEPPER ?? 'local-metrics-token-pepper-32-bytes',
      )
    : null;
const outboxRelay =
  config.role === 'domain' && process.env.DATABASE_URL
    ? startOutboxRelay({
        databaseUrl: process.env.DATABASE_URL,
        project: (event) => domainProjector!.projector.project(event),
        redisUrl: config.redisUrl,
      })
    : null;
const purgeExpiredMetrics = () =>
  domainProjector?.purgeExpiredMetrics().catch(() => {
    // The bounded interval retries; retention remains defined by the metric registry.
  });
if (domainProjector) void purgeExpiredMetrics();
const metricsPurgeTimer = domainProjector
  ? setInterval(() => void purgeExpiredMetrics(), 60 * 60 * 1000)
  : null;
metricsPurgeTimer?.unref();
const generatedLearning =
  config.role === 'ai'
    ? createConfiguredGeneratedLearningProcessor(
        process.env,
        providerGovernance.service,
        safetyEscalation.service,
      )
    : { handler: undefined, shutdownResources: [] };
const openAssessment =
  config.role === 'ai'
    ? createConfiguredOpenAssessmentProcessor(
        process.env,
        providerGovernance.service,
        safetyEscalation.service,
      )
    : { handler: undefined, shutdownResources: [] };
const reviewCard =
  config.role === 'ai'
    ? createConfiguredReviewCardProcessor(
        process.env,
        providerGovernance.service,
        safetyEscalation.service,
      )
    : { handler: undefined, shutdownResources: [] };
const submission =
  config.role === 'ai'
    ? createConfiguredSubmissionProcessor(process.env, providerGovernance.service)
    : { handler: undefined, shutdownResources: [] };
const privacy =
  config.role === 'safety'
    ? createConfiguredPrivacyProcessor(process.env, providerGovernance.service)
    : { handler: undefined, shutdownResources: [] };
const worker = createRoleWorker(config, {
  ...(submission.handler ? { submissionRecognitionHandler: submission.handler } : {}),
  ...(generatedLearning.handler ? { generatedLearningHandler: generatedLearning.handler } : {}),
  ...(openAssessment.handler ? { openAssessmentHandler: openAssessment.handler } : {}),
  ...(reviewCard.handler ? { reviewCardHandler: reviewCard.handler } : {}),
  ...(privacy.handler ? { privacyTaskHandler: privacy.handler } : {}),
});
if (
  process.env.NODE_ENV === 'production' &&
  ((config.role === 'ai' &&
    (!submission.handler ||
      !generatedLearning.handler ||
      !openAssessment.handler ||
      !reviewCard.handler)) ||
    (config.role === 'safety' && !privacy.handler) ||
    (config.role === 'domain' && (!domainProjector || !outboxRelay)))
) {
  throw new Error(`Required ${config.role} worker handlers are not configured`);
}

worker.on('ready', () => {
  console.log(JSON.stringify({ event: 'worker_ready', role: config.role }));
});
worker.on('completed', (job) => {
  console.log(JSON.stringify({ event: 'job_succeeded', jobId: job.id, role: config.role }));
});
worker.on('failed', (job) => {
  console.error(
    JSON.stringify({
      errorCode: 'JOB_HANDLER_FAILED',
      event: 'job_failed',
      jobId: job?.id ?? null,
      role: config.role,
    }),
  );
});
worker.on('error', () => {
  console.error(JSON.stringify({ errorCode: 'WORKER_RUNTIME_ERROR', event: 'worker_error' }));
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'worker_stopping', role: config.role, signal }));
  await worker.close();
  await Promise.all(generatedLearning.shutdownResources.map((resource) => resource.close()));
  await Promise.all(openAssessment.shutdownResources.map((resource) => resource.close()));
  await Promise.all(reviewCard.shutdownResources.map((resource) => resource.close()));
  await Promise.all(submission.shutdownResources.map((resource) => resource.close()));
  await Promise.all(privacy.shutdownResources.map((resource) => resource.close()));
  await Promise.all(providerGovernance.shutdownResources.map((resource) => resource.close()));
  await challengeReportClassifier?.close();
  await Promise.all(safetyEscalation.shutdownResources.map((resource) => resource.close()));
  await outboxRelay?.close();
  if (metricsPurgeTimer) clearInterval(metricsPurgeTimer);
  await domainProjector?.pool.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
