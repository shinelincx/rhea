import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('Today route HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('shows a usable empty route when there are no learning actions', async () => {
    app = await createApp();
    await app.init();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/today-route',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        generatedAt: expect.any(String),
        items: [],
        learnerProfileId: null,
      },
    });
  });

  it('allows the configured mobile web origin without opening the API to every site', async () => {
    app = await createApp({
      allowedOrigins: ['http://127.0.0.1:8081'],
      dependencyProbes: [],
    });
    await app.init();

    const allowed = await app.inject({
      headers: {
        origin: 'http://127.0.0.1:8081',
        'access-control-request-method': 'GET',
      },
      method: 'OPTIONS',
      url: '/v1/today-route',
    });
    const denied = await app.inject({
      headers: {
        origin: 'https://untrusted.example',
        'access-control-request-method': 'GET',
      },
      method: 'OPTIONS',
      url: '/v1/today-route',
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8081');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the mobile client to end a session through a CORS preflight', async () => {
    app = await createApp({
      allowedOrigins: ['http://127.0.0.1:8081'],
      dependencyProbes: [],
    });
    await app.init();

    const response = await app.inject({
      headers: {
        origin: 'http://127.0.0.1:8081',
        'access-control-request-method': 'DELETE',
      },
      method: 'OPTIONS',
      url: '/v1/session',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
  });
});
