import process from 'node:process';

import { parseWorkerConfig } from './config.js';
import { createRoleWorker } from './worker.js';
import { createConfiguredGeneratedLearningProcessor } from './create-generated-learning-processor.js';

const config = parseWorkerConfig(process.env, process.argv[2]);
const generatedLearning =
  config.role === 'ai'
    ? createConfiguredGeneratedLearningProcessor(process.env)
    : { handler: undefined, shutdownResources: [] };
const worker = createRoleWorker(
  config,
  generatedLearning.handler ? { generatedLearningHandler: generatedLearning.handler } : {},
);

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
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
