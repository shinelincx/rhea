import process from 'node:process';

import { createProbeWorker } from '@rhea/queue-adapter';

import { parseWorkerConfig } from './config.js';

const config = parseWorkerConfig(process.env, process.argv[2]);
const worker = createProbeWorker(config);

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
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
