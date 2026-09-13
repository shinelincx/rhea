import { GovernedHttpClient } from '@rhea/china-provider-adapters';
import { createS3ObjectStore } from '@rhea/object-storage-adapter';
import {
  PostgresPrivacyDataPort,
  PostgresPrivacyLifecycleStore,
  PostgresProfileEnvelopeObjectStore,
  ShanghaiKmsProfileKeyWrapper,
  type ExternalErasureHandler,
} from '@rhea/postgres-privacy';
import { PrivacyLifecycleService, type ErasureTarget } from '@rhea/privacy-lifecycle';
import type { ProviderGovernanceService } from '@rhea/provider-governance';
import { purgeLearningProfileJobs } from '@rhea/queue-adapter';
import { Redis } from 'ioredis';
import { Pool, type PoolClient } from 'pg';

import { createPrivacyTaskJobHandler } from './privacy-task-handler.js';

async function withPrivacyRole<Value>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Value>,
): Promise<Value> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_privacy_worker');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function requireValues(environment: Record<string, string | undefined>, names: string[]) {
  const values = Object.fromEntries(names.map((name) => [name, environment[name]]));
  if (Object.values(values).some((value) => !value)) {
    throw new Error(`Privacy erasure requires ${names.join(', ')}`);
  }
  return values as Record<string, string>;
}

export function createConfiguredPrivacyProcessor(
  environment: Record<string, string | undefined>,
  governance: ProviderGovernanceService,
): {
  handler: ReturnType<typeof createPrivacyTaskJobHandler> | undefined;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  if (!environment.DATABASE_URL) return { handler: undefined, shutdownResources: [] };
  const databaseUrl = environment.DATABASE_URL;
  const redisUrl = environment.REDIS_URL;
  const exportSecret = environment.PRIVACY_EXPORT_ENCRYPTION_SECRET;
  const tombstonePepper = environment.PRIVACY_TOMBSTONE_PEPPER;
  const metricsTokenPepper = environment.METRICS_TOKEN_PEPPER;
  if (!redisUrl || !exportSecret || !tombstonePepper || !metricsTokenPepper) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('Privacy worker requires Redis and privacy secrets');
    }
    return { handler: undefined, shutdownResources: [] };
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const objectConfig = requireValues(environment, [
    'OBJECT_STORE_BUCKET',
    'OBJECT_STORE_ENDPOINT',
    'OBJECT_STORE_REGION',
  ]);
  const objectCredentials =
    environment.NODE_ENV === 'production'
      ? {
          credentialsFile: requireValues(environment, ['WORKLOAD_CREDENTIALS_FILE'])
            .WORKLOAD_CREDENTIALS_FILE!,
          expectedRoleArn: requireValues(environment, ['WORKLOAD_ROLE_ARN']).WORKLOAD_ROLE_ARN!,
        }
      : {
          accessKeyId: requireValues(environment, ['OBJECT_STORE_ACCESS_KEY'])
            .OBJECT_STORE_ACCESS_KEY!,
          secretAccessKey: requireValues(environment, ['OBJECT_STORE_SECRET_KEY'])
            .OBJECT_STORE_SECRET_KEY!,
        };
  const objectStorage = createS3ObjectStore({
    bucket: objectConfig.OBJECT_STORE_BUCKET!,
    endpoint: objectConfig.OBJECT_STORE_ENDPOINT!,
    forcePathStyle: environment.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
    region: objectConfig.OBJECT_STORE_REGION!,
    ...objectCredentials,
  });
  const objectStoreKmsKeyId = requireValues(environment, [
    'OBJECT_STORE_KMS_KEY_ID',
  ]).OBJECT_STORE_KMS_KEY_ID!;
  const profileKeyWrapper =
    environment.NODE_ENV === 'production'
      ? new ShanghaiKmsProfileKeyWrapper({
          credentialsFile: objectCredentials.credentialsFile!,
          ...(environment.KMS_ENDPOINT ? { endpoint: environment.KMS_ENDPOINT } : {}),
          expectedRoleArn: objectCredentials.expectedRoleArn!,
          regionId: 'cn-shanghai',
        })
      : (environment.PROFILE_ENVELOPE_KEK ?? 'local-profile-envelope-kek-at-least-32-bytes');
  const profileAssetStore = new PostgresProfileEnvelopeObjectStore(
    pool,
    objectStorage.store,
    profileKeyWrapper,
    objectStoreKmsKeyId,
    'read-only',
  );
  const ledgerStorage = createS3ObjectStore({
    accessKeyId: requireValues(environment, ['ERASURE_LEDGER_WRITE_ACCESS_KEY'])
      .ERASURE_LEDGER_WRITE_ACCESS_KEY!,
    bucket: requireValues(environment, ['ERASURE_LEDGER_BUCKET']).ERASURE_LEDGER_BUCKET!,
    endpoint: objectConfig.OBJECT_STORE_ENDPOINT!,
    forcePathStyle: environment.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
    region: objectConfig.OBJECT_STORE_REGION!,
    secretAccessKey: requireValues(environment, ['ERASURE_LEDGER_WRITE_SECRET_KEY'])
      .ERASURE_LEDGER_WRITE_SECRET_KEY!,
  });

  function providerClient(kind: 'llm' | 'ocr') {
    const prefix = kind === 'llm' ? 'MODEL_GATEWAY' : 'OCR';
    const values = requireValues(environment, [
      `${prefix}_URL`,
      `${prefix}_DELETE_URL`,
      `${prefix}_TOKEN`,
      `${prefix}_CAPABILITY_VERSION_ID`,
    ]);
    return new GovernedHttpClient({
      authorizationToken: values[`${prefix}_TOKEN`]!,
      capabilityVersionId: values[`${prefix}_CAPABILITY_VERSION_ID`]!,
      dataCategories:
        kind === 'ocr' ? ['source_image', 'minimal_crop'] : ['confirmed_structured_learning_data'],
      governance,
      purpose: 'profile_erasure',
      url: values[`${prefix}_URL`]!,
      deletionUrl: values[`${prefix}_DELETE_URL`]!,
    });
  }

  const externalHandlers: Partial<Record<ErasureTarget, ExternalErasureHandler>> = {
    async cache(input) {
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          'rhea:challenge:*:records',
          'COUNT',
          '100',
        );
        cursor = next;
        for (const recordsKey of keys) {
          const entryId = await redis.hget(recordsKey, `profile:${input.learningProfileId}`);
          if (!entryId) continue;
          const bucketKey = recordsKey.replace(/:records$/, ':waiting');
          await redis
            .multi()
            .hdel(recordsKey, `profile:${input.learningProfileId}`, `entry:${entryId}`)
            .srem(bucketKey, entryId)
            .exec();
          removed += 1;
        }
      } while (cursor !== '0');
      const outboxReferences = await withPrivacyRole(pool, async (client) => {
        const result = await client.query<{ aggregate_id: string; event_id: string }>(
          'SELECT event_id,aggregate_id FROM learning.list_profile_outbox_references($1,$2)',
          [input.familySpaceId, input.learningProfileId],
        );
        return new Set(result.rows.flatMap((row) => [row.event_id, row.aggregate_id]));
      });
      let legacyStreamEntriesRemoved = 0;
      let streamCursor = '-';
      while (outboxReferences.size > 0) {
        const entries = await redis.xrange('rhea:domain-events', streamCursor, '+', 'COUNT', 500);
        if (entries.length === 0) break;
        const matched: string[] = [];
        for (const [entryId, fields] of entries) {
          const record = new Map<string, string>();
          for (let index = 0; index < fields.length; index += 2) {
            const name = fields[index];
            const value = fields[index + 1];
            if (name && value) record.set(name, value);
          }
          if (
            outboxReferences.has(record.get('eventId') ?? '') ||
            outboxReferences.has(record.get('aggregateId') ?? '')
          ) {
            matched.push(entryId);
          }
        }
        if (matched.length > 0)
          legacyStreamEntriesRemoved += await redis.xdel('rhea:domain-events', ...matched);
        const lastId = entries.at(-1)?.[0];
        if (!lastId || entries.length < 500) break;
        streamCursor = `(${lastId}`;
      }
      const jobs = await purgeLearningProfileJobs(
        { queueNames: ['rhea-ai', 'rhea-safety'], redisUrl },
        input.learningProfileId,
      );
      return {
        receipt: `redis-profile-data-deleted:matches=${removed};jobs=${jobs.removed};legacyStreamEntries=${legacyStreamEntriesRemoved}`,
      };
    },
    async object_storage(input) {
      const keys = await withPrivacyRole(pool, async (client) => {
        const result = await client.query<{ object_key: string }>(
          'SELECT object_key FROM learning.list_profile_object_keys($1,$2)',
          [input.familySpaceId, input.learningProfileId],
        );
        return result.rows.map(({ object_key }) => object_key);
      });
      for (const key of keys) await objectStorage.store.delete(key);
      return { receipt: `object-storage-deleted:${keys.length}` };
    },
    async vendor_copies(input) {
      const references = await withPrivacyRole(pool, async (client) => {
        const result = await client.query<{
          provider_kind: 'llm' | 'ocr' | 'ocr_missing';
          reference_value: string;
        }>(
          'SELECT provider_kind,reference_value FROM learning.list_profile_vendor_references($1,$2)',
          [input.familySpaceId, input.learningProfileId],
        );
        return result.rows;
      });
      const clients = new Map<'llm' | 'ocr', GovernedHttpClient>();
      for (const reference of references) {
        if (reference.provider_kind === 'ocr_missing') {
          throw new Error(`VENDOR_DELETE_HANDLE_MISSING:${reference.reference_value}`);
        }
        let client = clients.get(reference.provider_kind);
        if (!client) {
          client = providerClient(reference.provider_kind);
          clients.set(reference.provider_kind, client);
        }
        await client.delete(reference.reference_value);
      }
      return { receipt: `provider-copies-deleted:${references.length}` };
    },
  };
  const data = new PostgresPrivacyDataPort(
    pool,
    exportSecret,
    externalHandlers,
    async (tombstone) => {
      await ledgerStorage.store.put(
        `erasure-ledger/${tombstone.subjectToken}.json`,
        Buffer.from(JSON.stringify(tombstone), 'utf8'),
      );
    },
    metricsTokenPepper,
    'rhea_privacy_worker',
    profileAssetStore,
  );
  const service = new PrivacyLifecycleService(
    new PostgresPrivacyLifecycleStore(pool),
    data,
    tombstonePepper,
  );
  const purgeExpiredExports = () =>
    data.purgeExpiredExports().catch(() => {
      // The next bounded interval retries; export expiry remains enforced on download.
    });
  void purgeExpiredExports();
  const exportPurgeTimer = setInterval(() => void purgeExpiredExports(), 60 * 60 * 1000);
  exportPurgeTimer.unref();
  return {
    handler: createPrivacyTaskJobHandler(service),
    shutdownResources: [
      {
        async close() {
          clearInterval(exportPurgeTimer);
        },
      },
      { close: () => pool.end() },
      { close: () => redis.quit().then(() => undefined) },
      {
        async close() {
          objectStorage.client.destroy();
        },
      },
      {
        async close() {
          ledgerStorage.client.destroy();
        },
      },
    ],
  };
}
