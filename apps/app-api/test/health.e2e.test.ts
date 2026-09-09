import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';
import type { DependencyProbe } from '../src/health/dependency-probe.js';

describe('Health HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('keeps liveness separate from dependency readiness', async () => {
    const probes: DependencyProbe[] = [
      { name: 'database', check: async () => undefined },
      {
        name: 'redis',
        check: async () => {
          throw new Error('connection refused');
        },
      },
      { name: 'objectStorage', check: async () => undefined },
    ];
    app = await createApp({ dependencyProbes: probes });
    await app.init();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'alive' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      dependencies: {
        database: 'ready',
        objectStorage: 'ready',
        redis: 'unavailable',
      },
      status: 'not_ready',
    });
  });
});
