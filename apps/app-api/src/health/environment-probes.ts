import { createConnection } from 'node:net';

import type { DependencyName, DependencyProbe } from './dependency-probe.js';

const PROBE_TIMEOUT_MS = 1_500;

function tcpProbe(name: DependencyName, environmentKey: string): DependencyProbe {
  return {
    name,
    async check() {
      const value = process.env[environmentKey];
      if (!value) {
        throw new Error(`${environmentKey} is not configured`);
      }

      const url = new URL(value);
      const port = Number.parseInt(url.port, 10);
      if (!url.hostname || !Number.isInteger(port)) {
        throw new Error(`${environmentKey} must include a host and port`);
      }

      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: url.hostname, port });
        const timeout = setTimeout(
          () => socket.destroy(new Error('probe timed out')),
          PROBE_TIMEOUT_MS,
        );

        socket.once('connect', () => {
          clearTimeout(timeout);
          socket.end();
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    },
  };
}

function objectStorageProbe(): DependencyProbe {
  return {
    name: 'objectStorage',
    async check() {
      const value = process.env.OBJECT_STORE_HEALTH_URL;
      if (!value) {
        throw new Error('OBJECT_STORE_HEALTH_URL is not configured');
      }

      const response = await fetch(value, {
        method: 'GET',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`object storage health returned ${response.status}`);
      }
    },
  };
}

export function createEnvironmentDependencyProbes(): DependencyProbe[] {
  return [
    tcpProbe('database', 'DATABASE_URL'),
    tcpProbe('redis', 'REDIS_URL'),
    objectStorageProbe(),
  ];
}
