export type WorkerRole = 'ai' | 'domain' | 'safety';

export interface WorkerConfig {
  queueName: `rhea-${WorkerRole}`;
  redisUrl: string;
  role: WorkerRole;
}

const WORKER_ROLES = ['domain', 'ai', 'safety'] as const;

function isWorkerRole(value: string | undefined): value is WorkerRole {
  return WORKER_ROLES.some((role) => role === value);
}

export function parseWorkerConfig(
  environment: Record<string, string | undefined>,
  roleArgument?: string,
): WorkerConfig {
  const redisUrl = environment.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required');
  }

  const role = roleArgument ?? environment.WORKER_ROLE;
  if (!isWorkerRole(role)) {
    throw new Error(`WORKER_ROLE must be one of: ${WORKER_ROLES.join(', ')}`);
  }

  return {
    queueName: `rhea-${role}`,
    redisUrl,
    role,
  };
}
