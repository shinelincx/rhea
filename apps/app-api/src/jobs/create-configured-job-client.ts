import { createMemoryJobRuntime, type JobClient } from '@rhea/job-runtime';
import { BullMqJobClient } from '@rhea/queue-adapter';

const DOMAIN_QUEUE = 'rhea-domain';

export function createConfiguredJobClient(
  environment: Record<string, string | undefined>,
): JobClient {
  const redisUrl = environment.REDIS_URL;
  if (!redisUrl) {
    return createMemoryJobRuntime();
  }

  return new BullMqJobClient({ queueName: DOMAIN_QUEUE, redisUrl });
}
