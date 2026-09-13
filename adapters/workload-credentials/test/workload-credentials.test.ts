import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileWorkloadCredentialsProvider,
  readWorkloadCredentialFile,
  writeWorkloadCredentialFile,
} from '../src/index.js';

const roleArn = 'acs:ram::123456789:role/rhea-v1-workload-api';
const directories: string[] = [];

async function temporaryPath() {
  const directory = await mkdtemp(join(tmpdir(), 'rhea-workload-credentials-'));
  directories.push(directory);
  return join(directory, 'credentials.json');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('file workload credentials', () => {
  it('atomically writes and reloads a role-bound short-lived credential', async () => {
    const path = await temporaryPath();
    await writeWorkloadCredentialFile(path, {
      accessKeyId: 'STS.access-key',
      accessKeySecret: 'secret-value',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      roleArn,
      securityToken: 'security-token',
    });

    await expect(readWorkloadCredentialFile(path, roleArn)).resolves.toMatchObject({
      accessKeyId: 'STS.access-key',
      roleArn,
      schemaVersion: 1,
    });
    const provider = new FileWorkloadCredentialsProvider(path, roleArn);
    await expect(provider.getCredentials()).resolves.toMatchObject({
      accessKeyId: 'STS.access-key',
      providerName: 'workload_credential_file',
    });
  });

  it('fails closed for expired, role-swapped, or broadly readable files', async () => {
    const path = await temporaryPath();
    const document = {
      accessKeyId: 'STS.access-key',
      accessKeySecret: 'secret-value',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      roleArn,
      schemaVersion: 1,
      securityToken: 'security-token',
    };
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(path, 0o400);
    await expect(readWorkloadCredentialFile(path, roleArn)).rejects.toThrow(
      'WORKLOAD_CREDENTIAL_EXPIRED',
    );

    document.expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
    if (process.platform !== 'win32') await chmod(path, 0o600);
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(path, 0o400);
    await expect(
      readWorkloadCredentialFile(path, 'acs:ram::123456789:role/rhea-v1-workload-ai'),
    ).rejects.toThrow('WORKLOAD_CREDENTIAL_ROLE_MISMATCH');

    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await expect(readWorkloadCredentialFile(path, roleArn)).rejects.toThrow(
        'WORKLOAD_CREDENTIAL_FILE_PERMISSIONS_INVALID',
      );
    }
  });
});
