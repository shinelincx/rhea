import { createMemoryJobRuntime, type JobClient } from '@rhea/job-runtime';
import { BullMqJobClient } from '@rhea/queue-adapter';

const DOMAIN_QUEUE = 'rhea-domain';
const AI_QUEUE = 'rhea-ai';

function createConfiguredQueueClient(
  environment: Record<string, string | undefined>,
  queueName: string,
): JobClient {
  const redisUrl = environment.REDIS_URL;
  if (!redisUrl) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required in production');
    }
    return createMemoryJobRuntime();
  }

  return new BullMqJobClient({ queueName, redisUrl });
}

export function createConfiguredJobClient(
  environment: Record<string, string | undefined>,
): JobClient {
  return createConfiguredQueueClient(environment, DOMAIN_QUEUE);
}

export function createConfiguredAiJobClient(
  environment: Record<string, string | undefined>,
): JobClient {
  return createConfiguredQueueClient(environment, AI_QUEUE);
}
