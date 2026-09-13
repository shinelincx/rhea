import { chmod, chown, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CredentialsProvider } from '@alicloud/credentials';

const ROLE_ARN_PATTERN = /^acs:ram::\d+:role\/[a-z0-9-]+$/i;

export interface WorkloadCredentialDocument {
  accessKeyId: string;
  accessKeySecret: string;
  expiresAt: string;
  roleArn: string;
  schemaVersion: 1;
  securityToken: string;
}

export interface IssuedWorkloadCredential {
  accessKeyId: string;
  accessKeySecret: string;
  expiresAt: string;
  roleArn: string;
  securityToken: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRoleArn(roleArn: string): void {
  if (!ROLE_ARN_PATTERN.test(roleArn)) throw new Error('WORKLOAD_CREDENTIAL_ROLE_ARN_INVALID');
}

function validateDocument(
  value: unknown,
  expectedRoleArn: string,
  minimumValidityMs: number,
): WorkloadCredentialDocument {
  if (!value || typeof value !== 'object') throw new Error('WORKLOAD_CREDENTIAL_DOCUMENT_INVALID');
  const document = value as Partial<WorkloadCredentialDocument>;
  if (
    document.schemaVersion !== 1 ||
    !nonEmpty(document.accessKeyId) ||
    !nonEmpty(document.accessKeySecret) ||
    !nonEmpty(document.securityToken) ||
    !nonEmpty(document.expiresAt) ||
    !nonEmpty(document.roleArn)
  ) {
    throw new Error('WORKLOAD_CREDENTIAL_DOCUMENT_INVALID');
  }
  validateRoleArn(document.roleArn);
  if (document.roleArn !== expectedRoleArn) throw new Error('WORKLOAD_CREDENTIAL_ROLE_MISMATCH');
  const expiresAt = Date.parse(document.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + minimumValidityMs) {
    throw new Error('WORKLOAD_CREDENTIAL_EXPIRED');
  }
  return document as WorkloadCredentialDocument;
}

export async function readWorkloadCredentialFile(
  path: string,
  expectedRoleArn: string,
  minimumValidityMs = 60_000,
): Promise<WorkloadCredentialDocument> {
  if (!isAbsolute(path)) throw new Error('WORKLOAD_CREDENTIAL_FILE_PATH_INVALID');
  validateRoleArn(expectedRoleArn);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('WORKLOAD_CREDENTIAL_FILE_TYPE_INVALID');
  }
  if (process.platform !== 'win32' && ![0o400, 0o440].includes(metadata.mode & 0o777)) {
    throw new Error('WORKLOAD_CREDENTIAL_FILE_PERMISSIONS_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('WORKLOAD_CREDENTIAL_DOCUMENT_INVALID');
  }
  return validateDocument(parsed, expectedRoleArn, minimumValidityMs);
}

export async function writeWorkloadCredentialFile(
  path: string,
  credential: IssuedWorkloadCredential,
  owner?: { gid: number; uid: number },
): Promise<void> {
  if (!isAbsolute(path)) throw new Error('WORKLOAD_CREDENTIAL_FILE_PATH_INVALID');
  validateRoleArn(credential.roleArn);
  const document = validateDocument(
    { ...credential, schemaVersion: 1 },
    credential.roleArn,
    5 * 60_000,
  );
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporaryPath = join(directory, '.credentials-' + randomUUID() + '.tmp');
  await writeFile(temporaryPath, JSON.stringify(document) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o440);
  if (owner) await chown(temporaryPath, owner.uid, owner.gid);
  await rename(temporaryPath, path);
}

export class FileWorkloadCredentialsProvider implements CredentialsProvider {
  constructor(
    readonly path: string,
    readonly expectedRoleArn: string,
  ) {
    if (!isAbsolute(path)) throw new Error('WORKLOAD_CREDENTIAL_FILE_PATH_INVALID');
    validateRoleArn(expectedRoleArn);
  }

  getProviderName(): string {
    return 'workload_credential_file';
  }

  async getCredentials() {
    const document = await readWorkloadCredentialFile(this.path, this.expectedRoleArn);
    return {
      accessKeyId: document.accessKeyId,
      accessKeySecret: document.accessKeySecret,
      providerName: this.getProviderName(),
      securityToken: document.securityToken,
    };
  }
}
