import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

const hasInfrastructure = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.OBJECT_STORE_HEALTH_URL,
);
const describeWithInfrastructure = hasInfrastructure ? describe : describe.skip;
let app: NestFastifyApplication | undefined;

afterAll(async () => {
  await app?.close();
});

describeWithInfrastructure('environment dependency readiness', () => {
  it('reports ready when PostgreSQL, Redis, and object storage are reachable', async () => {
    app = await createApp();
    await app.init();

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dependencies: {
        database: 'ready',
        objectStorage: 'ready',
        redis: 'ready',
      },
      status: 'ready',
    });
  });
});
