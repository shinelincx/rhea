import { readWorkloadCredentialFile } from '@rhea/workload-credentials-adapter';

import {
  createAliCloudCredentialIssuer,
  issueWorkloadCredentials,
  type WorkloadRoleTarget,
} from './broker.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required for the credential broker');
  return value;
}

function targets(): WorkloadRoleTarget[] {
  return [
    {
      outputPath: required('CREDENTIAL_BROKER_API_OUTPUT'),
      roleArn: required('CREDENTIAL_BROKER_API_ROLE_ARN'),
      workload: 'api',
    },
    {
      outputPath: required('CREDENTIAL_BROKER_AI_OUTPUT'),
      roleArn: required('CREDENTIAL_BROKER_AI_ROLE_ARN'),
      workload: 'ai',
    },
    {
      outputPath: required('CREDENTIAL_BROKER_SAFETY_OUTPUT'),
      roleArn: required('CREDENTIAL_BROKER_SAFETY_ROLE_ARN'),
      workload: 'safety',
    },
  ];
}

async function healthcheck() {
  await Promise.all(
    targets().map((target) =>
      readWorkloadCredentialFile(target.outputPath, target.roleArn, 2 * 60_000),
    ),
  );
}

async function serve() {
  const configuredTargets = targets();
  const issuer = createAliCloudCredentialIssuer({
    baseRamRoleName: required('CREDENTIAL_BROKER_BASE_RAM_ROLE_NAME'),
    region: 'cn-shanghai',
  });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let retryDelayMs = 0;
  while (!stopping) {
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      const issued = await issueWorkloadCredentials(configuredTargets, issuer, {
        gid: 1000,
        uid: 0,
      });
      console.log(JSON.stringify({ event: 'workload_credentials_rotated', issued }));
      retryDelayMs = 15 * 60_000;
    } catch (error) {
      console.error(
        JSON.stringify({
          alert: true,
          error: error instanceof Error ? error.message : String(error),
          event: 'workload_credential_refresh_failed',
          requiresOperatorAction: true,
          severity: 'critical',
        }),
      );
      retryDelayMs = 60_000;
    }
  }
}

const mode = process.argv[2] ?? 'serve';
if (mode === 'healthcheck') {
  await healthcheck();
} else if (mode === 'smoke') {
  const { runCloudCredentialSmoke } = await import('./cloud-smoke.js');
  console.log(JSON.stringify(await runCloudCredentialSmoke()));
} else {
  await serve();
}
