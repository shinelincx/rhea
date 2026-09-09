import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createS3ObjectStore } from '../src/index.js';

const endpoint = process.env.OBJECT_STORE_ENDPOINT;
const describeWithObjectStore = endpoint ? describe : describe.skip;

describeWithObjectStore('S3-compatible private object storage', () => {
  it('writes, reads, deletes, and verifies raw asset removal', async () => {
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
      await expect(store.get(key)).resolves.toEqual(new Uint8Array([1, 2, 3]));
      await expect(store.delete(key)).resolves.toMatchObject({ proof: expect.any(String) });
      await expect(store.get(key)).resolves.toBeNull();
    } finally {
      client.destroy();
    }
  });
});
