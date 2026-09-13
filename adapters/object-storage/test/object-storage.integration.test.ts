import { randomUUID } from 'node:crypto';

import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { createS3ObjectStore } from '../src/index.js';

const endpoint = process.env.OBJECT_STORE_ENDPOINT;
const describeWithObjectStore = endpoint ? describe : describe.skip;

describe('S3-compatible credential boundary', () => {
  it('accepts only a role-bound credential file for production OSS access', () => {
    const configured = createS3ObjectStore({
      bucket: 'rhea-private',
      credentialsFile: '/run/rhea-credentials/credentials.json',
      endpoint: 'https://oss-cn-shanghai-internal.aliyuncs.com',
      expectedRoleArn: 'acs:ram::123456789:role/rhea-v1-workload-api',
      region: 'cn-shanghai',
    });
    expect(configured.store).toBeDefined();
    configured.client.destroy();
  });
});

describeWithObjectStore('S3-compatible private object storage', () => {
  it('deletes every version and verifies raw asset removal', async () => {
    if (!endpoint) return;
    const { client, store } = createS3ObjectStore({
      accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY ?? 'rhea',
      bucket: process.env.OBJECT_STORE_BUCKET ?? 'rhea-private',
      endpoint,
      forcePathStyle: true,
      region: process.env.OBJECT_STORE_REGION ?? 'cn-shanghai',
      secretAccessKey: process.env.OBJECT_STORE_SECRET_KEY ?? 'rhea_dev_password',
    });
    const key = `ingest-temporary/test/${randomUUID()}`;
    try {
      await store.put(key, new Uint8Array([1, 2, 3]));
      await store.put(key, new Uint8Array([4, 5, 6]));
      await expect(store.get(key)).resolves.toEqual(new Uint8Array([4, 5, 6]));
      await expect(store.delete(key)).resolves.toMatchObject({
        proof: expect.stringMatching(/^s3-delete-all-versions:[2-9]\d*:/),
      });
      await expect(store.get(key)).resolves.toBeNull();
      await expect(store.delete(key)).resolves.toMatchObject({
        proof: expect.stringMatching(/^s3-delete-all-versions:0:/),
      });
      const remaining = await client.send(
        new ListObjectVersionsCommand({
          Bucket: process.env.OBJECT_STORE_BUCKET ?? 'rhea-private',
          Prefix: key,
        }),
      );
      expect([...(remaining.Versions ?? []), ...(remaining.DeleteMarkers ?? [])]).toEqual([]);
    } finally {
      client.destroy();
    }
  });
});
