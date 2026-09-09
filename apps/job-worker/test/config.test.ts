import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config.js';

describe('worker configuration interface', () => {
  it.each([
    ['domain', 'rhea-domain'],
    ['ai', 'rhea-ai'],
    ['safety', 'rhea-safety'],
  ] as const)('maps the %s process role to its isolated queue', (role, queueName) => {
    expect(parseWorkerConfig({ REDIS_URL: 'redis://localhost:6379' }, role)).toEqual({
      queueName,
      redisUrl: 'redis://localhost:6379',
      role,
    });
  });

  it('fails startup when the role or Redis connection is not configured', () => {
    expect(() => parseWorkerConfig({}, 'domain')).toThrow('REDIS_URL is required');
    expect(() => parseWorkerConfig({ REDIS_URL: 'redis://localhost:6379' }, 'unknown')).toThrow(
      'WORKER_ROLE must be one of',
    );
  });
});
