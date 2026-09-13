import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { issueWorkloadCredentials } from '../src/broker.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('credential broker', () => {
  it('issues separate role-bound files without exposing the base identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rhea-broker-'));
    directories.push(directory);
    const getCredential = vi.fn(async (roleArn: string) => ({
      accessKeyId: 'STS.' + roleArn.split('/').at(-1),
      accessKeySecret: 'secret-for-' + roleArn,
      securityToken: 'token-for-' + roleArn,
    }));
    const roles = ['api', 'ai', 'safety'].map((workload) => ({
      outputPath: join(directory, workload, 'credentials.json'),
      roleArn: 'acs:ram::123456789:role/rhea-v1-workload-' + workload,
      workload,
    }));

    const issued = await issueWorkloadCredentials(roles, getCredential);

    expect(issued).toHaveLength(3);
    expect(new Set(issued.map(({ roleArn }) => roleArn)).size).toBe(3);
    expect(getCredential).toHaveBeenCalledTimes(3);
  });
});
