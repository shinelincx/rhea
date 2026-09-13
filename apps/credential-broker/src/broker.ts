import { createRequire } from 'node:module';

import {
  ECSRAMRoleCredentialsProvider,
  RAMRoleARNCredentialsProvider,
} from '@alicloud/credentials';
import { writeWorkloadCredentialFile } from '@rhea/workload-credentials-adapter';

const require = createRequire(import.meta.url);
const CredentialConstructor = (
  require('@alicloud/credentials') as {
    default: typeof import('@alicloud/credentials').default;
  }
).default;

export interface WorkloadRoleTarget {
  outputPath: string;
  roleArn: string;
  workload: string;
}

export interface TemporaryCredential {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
}

export type CredentialIssuer = (roleArn: string, workload: string) => Promise<TemporaryCredential>;

export function createAliCloudCredentialIssuer(input: {
  baseRamRoleName: string;
  region: 'cn-shanghai';
}): CredentialIssuer {
  return async (roleArn, workload) => {
    const credential = new CredentialConstructor(
      null,
      RAMRoleARNCredentialsProvider.builder()
        .withCredentialsProvider(
          ECSRAMRoleCredentialsProvider.builder()
            .withRoleName(input.baseRamRoleName)
            .withDisableIMDSv1(true)
            .build(),
        )
        .withDurationSeconds(3600)
        .withEnableVpc(true)
        .withRoleArn(roleArn)
        .withRoleSessionName('rhea-' + workload + '-' + Date.now())
        .withStsRegionId(input.region)
        .build(),
    );
    const issued = await credential.getCredential();
    if (!issued.accessKeyId || !issued.accessKeySecret || !issued.securityToken) {
      throw new Error('CREDENTIAL_BROKER_STS_RESPONSE_INVALID');
    }
    return {
      accessKeyId: issued.accessKeyId,
      accessKeySecret: issued.accessKeySecret,
      securityToken: issued.securityToken,
    };
  };
}

export async function issueWorkloadCredentials(
  targets: WorkloadRoleTarget[],
  issuer: CredentialIssuer,
  owner?: { gid: number; uid: number },
): Promise<Array<{ expiresAt: string; roleArn: string; workload: string }>> {
  const uniqueRoles = new Set(targets.map(({ roleArn }) => roleArn));
  const uniquePaths = new Set(targets.map(({ outputPath }) => outputPath));
  if (uniqueRoles.size !== targets.length || uniquePaths.size !== targets.length) {
    throw new Error('CREDENTIAL_BROKER_TARGETS_MUST_BE_UNIQUE');
  }
  const expiresAt = new Date(Date.now() + 45 * 60_000).toISOString();
  const credentials = await Promise.all(
    targets.map(async (target) => ({
      ...target,
      ...(await issuer(target.roleArn, target.workload)),
    })),
  );
  await Promise.all(
    credentials.map((credential) =>
      writeWorkloadCredentialFile(
        credential.outputPath,
        {
          accessKeyId: credential.accessKeyId,
          accessKeySecret: credential.accessKeySecret,
          expiresAt,
          roleArn: credential.roleArn,
          securityToken: credential.securityToken,
        },
        owner,
      ),
    ),
  );
  return targets.map(({ roleArn, workload }) => ({ expiresAt, roleArn, workload }));
}
