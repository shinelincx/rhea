#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const entrypoints = [
  {
    arguments: [],
    expected:
      /DATABASE_URL is required|Production CORS allow-list|SUPPORT_PRINCIPAL_TOKENS and SUPPORT_DATABASE_URL/,
    name: 'api',
    path: 'apps/app-api/dist/main.js',
  },
  {
    arguments: ['ai'],
    expected: /REDIS_URL is required/,
    name: 'worker-ai',
    path: 'apps/job-worker/dist/main.js',
  },
  {
    arguments: ['domain'],
    expected: /REDIS_URL is required/,
    name: 'worker-domain',
    path: 'apps/job-worker/dist/main.js',
  },
  {
    arguments: ['safety'],
    expected: /REDIS_URL is required/,
    name: 'worker-safety',
    path: 'apps/job-worker/dist/main.js',
  },
  {
    arguments: ['healthcheck'],
    expected: /CREDENTIAL_BROKER_API_OUTPUT is required/,
    name: 'credential-broker',
    path: 'apps/credential-broker/dist/main.js',
  },
];

const results = [];
const inheritedEnvironment = Object.fromEntries(
  ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR']
    .map((name) => [name, process.env[name]])
    .filter((entry) => entry[1]),
);
for (const entrypoint of entrypoints) {
  const result = spawnSync(
    process.execPath,
    ['--conditions=production', entrypoint.path, ...entrypoint.arguments],
    {
      encoding: 'utf8',
      env: { ...inheritedEnvironment, NODE_ENV: 'production' },
      timeout: 10_000,
    },
  );
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (
    result.error ||
    result.status === 0 ||
    /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Unknown file extension/.test(output) ||
    !entrypoint.expected.test(output)
  ) {
    process.stderr.write(
      JSON.stringify({
        error: result.error?.message,
        event: 'production_entrypoint_cold_start_failed',
        name: entrypoint.name,
        output,
        status: result.status,
      }) + '\n',
    );
    process.exit(1);
  }
  results.push(entrypoint.name);
}

console.log(
  JSON.stringify({ event: 'production_entrypoint_imports_verified', passed: true, results }),
);
