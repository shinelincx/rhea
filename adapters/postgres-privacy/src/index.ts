import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

import { DecryptRequest, EncryptRequest } from '@alicloud/kms20160120';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';
import type {
  ErasureCertificate,
  ErasureTarget,
  ErasureTombstone,
  PrivacyDataPort,
  PrivacyLifecycleStore,
  PrivacyScope,
  PrivacyTask,
} from '@rhea/privacy-lifecycle';
import type { ObjectStorePort } from '@rhea/submission';
import { FileWorkloadCredentialsProvider } from '@rhea/workload-credentials-adapter';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface TaskRow extends QueryResultRow {
  attempts: number;
  completed_at: Date | null;
  created_at: Date;
  deadline_at: Date;
  download: PrivacyTask['download'];
  error_code: string | null;
  family_space_id: string;
  id: string;
  kind: PrivacyTask['kind'];
  learning_profile_id: string;
  requested_by_guardian_id: string;
  status: PrivacyTask['status'];
  target_receipts: PrivacyTask['targetReceipts'];
  updated_at: Date;
}
interface TombstoneRow extends QueryResultRow {
  completed_at: Date;
  completion_certificate_id: string;
  created_at: Date;
  subject_token: string;
  task_id: string;
  target_names: ErasureTombstone['targetNames'];
}

const ENVELOPE_MAGIC = Buffer.from('RHEAENV1', 'ascii');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = createRequire(import.meta.url);
const CredentialConstructor = (
  require('@alicloud/credentials') as {
    default: typeof import('@alicloud/credentials').default;
  }
).default;
const KmsClientConstructor = (
  require('@alicloud/kms20160120') as {
    default: typeof import('@alicloud/kms20160120').default;
  }
).default;

export interface ProfileKeyWrappingPort {
  unwrap(input: {
    familySpaceId: string;
    kmsKeyId: string;
    learningProfileId: string;
    wrappedKey: Uint8Array;
  }): Promise<Uint8Array>;
  wrap(input: {
    familySpaceId: string;
    kmsKeyId: string;
    learningProfileId: string;
    plaintextKey: Uint8Array;
  }): Promise<Uint8Array>;
}

function decryptAesGcm(key: Buffer, encrypted: Buffer, offset = 0): Buffer {
  if (encrypted.byteLength < offset + 29) throw new Error('ENCRYPTED_OBJECT_INVALID');
  const iv = encrypted.subarray(offset, offset + 12);
  const tag = encrypted.subarray(offset + 12, offset + 28);
  const ciphertext = encrypted.subarray(offset + 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptAesGcm(key: Buffer, plaintext: Uint8Array, prefix?: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([...(prefix ? [prefix] : []), iv, cipher.getAuthTag(), ciphertext]);
}

class LocalAesProfileKeyWrapper implements ProfileKeyWrappingPort {
  readonly #key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32)
      throw new Error('Profile envelope KEK must contain at least 32 characters');
    this.#key = createHash('sha256').update(secret).digest();
  }
  async wrap(input: { plaintextKey: Uint8Array }) {
    return encryptAesGcm(this.#key, input.plaintextKey);
  }
  async unwrap(input: { wrappedKey: Uint8Array }) {
    return decryptAesGcm(this.#key, Buffer.from(input.wrappedKey));
  }
}

export class ShanghaiKmsProfileKeyWrapper implements ProfileKeyWrappingPort {
  readonly #client: InstanceType<typeof KmsClientConstructor>;
  constructor(input: {
    credentialsFile: string;
    endpoint?: string;
    expectedRoleArn: string;
    regionId: 'cn-shanghai';
  }) {
    const credential = new CredentialConstructor(
      null,
      new FileWorkloadCredentialsProvider(input.credentialsFile, input.expectedRoleArn),
    );
    this.#client = new KmsClientConstructor(
      new OpenApiConfig({
        connectTimeout: 10_000,
        credential,
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        protocol: 'HTTPS',
        readTimeout: 10_000,
        regionId: input.regionId,
      }),
    );
  }
  async wrap(input: {
    familySpaceId: string;
    kmsKeyId: string;
    learningProfileId: string;
    plaintextKey: Uint8Array;
  }) {
    const response = await this.#client.encrypt(
      new EncryptRequest({
        encryptionContext: this.#context(input),
        keyId: input.kmsKeyId,
        plaintext: Buffer.from(input.plaintextKey).toString('base64'),
      }),
    );
    if (response.body?.keyId !== input.kmsKeyId || !response.body.ciphertextBlob) {
      throw new Error('KMS_WRAP_RESPONSE_INVALID');
    }
    return Buffer.from(response.body.ciphertextBlob, 'base64');
  }
  async unwrap(input: {
    familySpaceId: string;
    kmsKeyId: string;
    learningProfileId: string;
    wrappedKey: Uint8Array;
  }) {
    const response = await this.#client.decrypt(
      new DecryptRequest({
        ciphertextBlob: Buffer.from(input.wrappedKey).toString('base64'),
        encryptionContext: this.#context(input),
      }),
    );
    if (!response.body?.plaintext) {
      throw new Error('KMS_UNWRAP_RESPONSE_INVALID');
    }
    const plaintext = Buffer.from(response.body.plaintext, 'base64');
    if (plaintext.byteLength !== 32) throw new Error('KMS_UNWRAPPED_KEY_INVALID');
    return plaintext;
  }
  #context(input: { familySpaceId: string; learningProfileId: string }) {
    return {
      familySpaceId: input.familySpaceId,
      learningProfileId: input.learningProfileId,
      workload: 'rhea-profile-envelope',
    };
  }
}

export class PostgresProfileEnvelopeObjectStore implements ObjectStorePort {
  readonly #keyWrapper: ProfileKeyWrappingPort;

  constructor(
    readonly pool: Pool,
    readonly objectStore: ObjectStorePort,
    keyWrapper: string | ProfileKeyWrappingPort,
    readonly kmsKeyId: string,
    readonly access: 'read-only' | 'read-write' = 'read-write',
  ) {
    if (!kmsKeyId.trim()) throw new Error('Profile envelope KMS key id is required');
    this.#keyWrapper =
      typeof keyWrapper === 'string' ? new LocalAesProfileKeyWrapper(keyWrapper) : keyWrapper;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.access === 'read-only') throw new Error('PROFILE_OBJECT_STORE_READ_ONLY');
    await this.#withProfileFence(key, async (client, scope) => {
      const dataKey = await this.#dataKeyWithSession(client, scope, true);

      // The session-level profile fence remains held across the external call,
      // but the database transaction used to validate and read the DEK has
      // already committed. Erasure therefore runs wholly before or after this
      // acknowledgement without a long-lived database transaction.
      await this.objectStore.put(key, encryptAesGcm(dataKey, bytes, ENVELOPE_MAGIC));
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#withProfileFence(key, async (client, scope) => {
      // Hold the session fence while reading and, for a legacy SSE-KMS object,
      // replacing the value. No object-store call runs inside a DB transaction.
      const encrypted = await this.objectStore.get(key);
      if (!encrypted) return null;
      const buffer = Buffer.from(encrypted);
      const hasEnvelope = buffer.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC);
      if (!hasEnvelope && this.access === 'read-only') return buffer;
      const dataKey = await this.#dataKeyWithSession(client, scope, !hasEnvelope);
      if (!hasEnvelope) {
        await this.objectStore.put(key, encryptAesGcm(dataKey, buffer, ENVELOPE_MAGIC));
        return buffer;
      }
      return decryptAesGcm(dataKey, buffer, ENVELOPE_MAGIC.length);
    });
  }

  delete(key: string) {
    if (this.access === 'read-only') {
      return Promise.reject(new Error('PROFILE_OBJECT_STORE_READ_ONLY'));
    }
    return this.objectStore.delete(key);
  }

  async #dataKeyWithSession(
    client: PoolClient,
    scope: { familySpaceId: string; learningProfileId: string },
    create: boolean,
  ): Promise<Buffer> {
    let row = await this.#withCryptoClient(client, async (transaction) => {
      const result = await transaction.query<{ kms_key_id: string; wrapped_key: Buffer }>(
        'SELECT kms_key_id,wrapped_key FROM learning.get_profile_key_wrap($1,$2)',
        [scope.familySpaceId, scope.learningProfileId],
      );
      return result.rows[0] ?? null;
    });
    if (!row && create) {
      const dataKey = randomBytes(32);
      const wrapped = await this.#keyWrapper.wrap({
        kmsKeyId: this.kmsKeyId,
        familySpaceId: scope.familySpaceId,
        learningProfileId: scope.learningProfileId,
        plaintextKey: dataKey,
      });
      row = await this.#withCryptoClient(client, async (transaction) => {
        const created = await transaction.query<{ created: boolean }>(
          'SELECT learning.create_profile_key_wrap($1,$2,$3,$4) AS created',
          [scope.familySpaceId, scope.learningProfileId, this.kmsKeyId, wrapped],
        );
        if (created.rows[0]?.created)
          return { kms_key_id: this.kmsKeyId, wrapped_key: Buffer.from(wrapped) };
        const existing = await transaction.query<{ kms_key_id: string; wrapped_key: Buffer }>(
          'SELECT kms_key_id,wrapped_key FROM learning.get_profile_key_wrap($1,$2)',
          [scope.familySpaceId, scope.learningProfileId],
        );
        return existing.rows[0] ?? null;
      });
      if (row?.kms_key_id === this.kmsKeyId && Buffer.from(row.wrapped_key).equals(wrapped)) {
        return dataKey;
      }
    }
    if (!row) throw new Error('PROFILE_KEY_UNAVAILABLE');
    return Buffer.from(
      await this.#keyWrapper.unwrap({
        familySpaceId: scope.familySpaceId,
        kmsKeyId: row.kms_key_id,
        learningProfileId: scope.learningProfileId,
        wrappedKey: row.wrapped_key,
      }),
    );
  }

  async #scopeWithClient(
    client: PoolClient,
    key: string,
  ): Promise<{ familySpaceId: string; learningProfileId: string }> {
    const [, first, second, ...tail] = key.split('/');
    if (!key.startsWith('ingest-temporary/') || !first || !second || tail.length === 0)
      throw new Error('PROFILE_OBJECT_KEY_INVALID');
    if (!UUID_PATTERN.test(first)) throw new Error('PROFILE_OBJECT_KEY_INVALID');

    // New and legacy keys have the same segment count. Resolve candidate UUIDs
    // against the authoritative profile table instead of guessing by shape.
    if (UUID_PATTERN.test(second)) {
      const secondFamily = await this.#familyForProfile(client, second);
      if (secondFamily?.toLowerCase() === first.toLowerCase())
        return { familySpaceId: secondFamily, learningProfileId: second };
    }
    const firstFamily = await this.#familyForProfile(client, first);
    if (!firstFamily) throw new Error('PROFILE_KEY_UNAVAILABLE');
    return { familySpaceId: firstFamily, learningProfileId: first };
  }

  async #familyForProfile(client: PoolClient, learningProfileId: string) {
    const result = await client.query<{ family_space_id: string }>(
      'SELECT family_space_id FROM learning.resolve_profile_family_for_crypto($1)',
      [learningProfileId],
    );
    return result.rows[0]?.family_space_id ?? null;
  }

  async #withProfileFence<Value>(
    key: string,
    operation: (
      client: PoolClient,
      scope: { familySpaceId: string; learningProfileId: string },
    ) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    let lockedProfileId: string | null = null;
    try {
      const scope = await this.#withCryptoClient(client, (transaction) =>
        this.#scopeWithClient(transaction, key),
      );
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        scope.learningProfileId,
      ]);
      lockedProfileId = scope.learningProfileId;
      await this.#withCryptoClient(client, async (transaction) => {
        const authoritativeFamily = await this.#familyForProfile(
          transaction,
          scope.learningProfileId,
        );
        if (!authoritativeFamily || authoritativeFamily !== scope.familySpaceId)
          throw new Error('PROFILE_KEY_UNAVAILABLE');
        const writable = await transaction.query<{ writable: boolean }>(
          'SELECT learning.profile_accepts_upload($1) AS writable',
          [scope.learningProfileId],
        );
        if (!writable.rows[0]?.writable) throw new Error('PROFILE_FROZEN_FOR_ERASURE');
      });
      return await operation(client, scope);
    } finally {
      if (lockedProfileId) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockedProfileId]);
      }
      client.release();
    }
  }

  async #withCryptoClient<Value>(
    client: PoolClient,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    try {
      await client.query('BEGIN');
      await client.query(
        `SET LOCAL ROLE ${
          this.access === 'read-only' ? 'rhea_profile_crypto_reader' : 'rhea_profile_crypto'
        }`,
      );
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}
function task(row: TaskRow): PrivacyTask {
  return {
    attempts: row.attempts,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(),
    download: row.download,
    errorCode: row.error_code,
    familySpaceId: row.family_space_id,
    id: row.id,
    kind: row.kind,
    learningProfileId: row.learning_profile_id,
    requestedByGuardianId: row.requested_by_guardian_id,
    status: row.status,
    targetReceipts: row.target_receipts,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresPrivacyLifecycleStore implements PrivacyLifecycleStore {
  constructor(
    readonly pool: Pool,
    readonly databaseRole: 'rhea_privacy_api' | 'rhea_privacy_worker' = 'rhea_privacy_worker',
  ) {}
  async createTask(value: PrivacyTask) {
    return this.#withWorker(
      async (client) => {
        const inserted = await client.query<TaskRow>(
          `INSERT INTO learning.privacy_tasks (id,family_space_id,learning_profile_id,kind,status,attempts,error_code,target_receipts,download,requested_by_guardian_id,created_at,updated_at,deadline_at,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (family_space_id,learning_profile_id,kind)
           WHERE kind='erasure' AND status IN ('pending','processing','retry_scheduled')
         DO NOTHING RETURNING *`,
          [
            value.id,
            value.familySpaceId,
            value.learningProfileId,
            value.kind,
            value.status,
            value.attempts,
            value.errorCode,
            value.targetReceipts,
            value.download,
            value.requestedByGuardianId,
            value.createdAt,
            value.updatedAt,
            value.deadlineAt,
            value.completedAt,
          ],
        );
        let stored = inserted.rows[0];
        if (!stored) {
          const existing = await client.query<TaskRow>(
            `${this.#select()} WHERE family_space_id=$1 AND learning_profile_id=$2
             AND kind='erasure' AND status IN ('pending','processing','retry_scheduled')
           ORDER BY created_at,id LIMIT 1`,
            [value.familySpaceId, value.learningProfileId],
          );
          stored = existing.rows[0];
        }
        if (!stored) throw new Error('PRIVACY_TASK_CREATE_CONFLICT');
        const storedTask = task(stored);
        await client.query(
          `INSERT INTO learning.domain_outbox
          (id,family_space_id,learning_profile_id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
         VALUES ($1,$2,$3,'privacy_task',$1,'privacy.task.requested',$4,$5)
         ON CONFLICT (id) DO NOTHING`,
          [
            storedTask.id,
            storedTask.familySpaceId,
            storedTask.learningProfileId,
            { kind: storedTask.kind, taskId: storedTask.id },
            storedTask.createdAt,
          ],
        );
        return storedTask;
      },
      { familySpaceId: value.familySpaceId },
    );
  }
  async findTask(id: string, scope?: { familySpaceId: string }) {
    return this.#withWorker(async (client) => {
      const result = await client.query<TaskRow>(`${this.#select()} WHERE id=$1`, [id]);
      return result.rows[0] ? task(result.rows[0]) : null;
    }, scope);
  }
  async findCertificate(taskId: string, scope?: { familySpaceId: string }) {
    return this.#withWorker(async (client) => {
      const result = await client.query<{
        completed_at: Date;
        id: string;
        statement: string;
        target_names: ErasureTarget[];
        task_id: string;
      }>(
        `SELECT id,task_id,statement,target_names,completed_at
         FROM learning.erasure_certificates WHERE task_id=$1`,
        [taskId],
      );
      const row = result.rows[0];
      return row
        ? {
            completedAt: row.completed_at.toISOString(),
            id: row.id,
            statement: row.statement,
            targetNames: row.target_names,
            taskId: row.task_id,
          }
        : null;
    }, scope);
  }
  async updateTask(value: PrivacyTask) {
    await this.#withWorker((client) =>
      client
        .query(
          `UPDATE learning.privacy_tasks SET status=$2,attempts=$3,error_code=$4,target_receipts=$5,download=$6,updated_at=$7,completed_at=$8 WHERE id=$1`,
          [
            value.id,
            value.status,
            value.attempts,
            value.errorCode,
            value.targetReceipts,
            value.download,
            value.updatedAt,
            value.completedAt,
          ],
        )
        .then(() => undefined),
    );
  }
  async listTombstones() {
    return this.#withWorker(async (client) => {
      const result = await client.query<TombstoneRow>(
        `SELECT task_id,subject_token,completion_certificate_id,target_names,created_at,completed_at FROM learning.erasure_tombstones ORDER BY created_at,task_id`,
      );
      return result.rows.map((row) => ({
        completedAt: row.completed_at.toISOString(),
        completionCertificateId: row.completion_certificate_id,
        createdAt: row.created_at.toISOString(),
        subjectToken: row.subject_token,
        taskId: row.task_id,
        targetNames: row.target_names,
      }));
    });
  }
  async completeErasure(
    completedTask: PrivacyTask,
    certificate: ErasureCertificate,
    tombstone: ErasureTombstone,
  ) {
    await this.#withWorker(async (client) => {
      await client.query(
        `INSERT INTO learning.erasure_certificates (id,task_id,statement,target_names,completed_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (task_id) DO UPDATE SET
           statement=EXCLUDED.statement,target_names=EXCLUDED.target_names,completed_at=EXCLUDED.completed_at`,
        [
          certificate.id,
          certificate.taskId,
          certificate.statement,
          certificate.targetNames,
          certificate.completedAt,
        ],
      );
      await client.query(
        `INSERT INTO learning.erasure_tombstones (task_id,subject_token,completion_certificate_id,target_names,created_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (subject_token) DO UPDATE SET completed_at=EXCLUDED.completed_at,completion_certificate_id=EXCLUDED.completion_certificate_id,target_names=EXCLUDED.target_names`,
        [
          tombstone.taskId,
          tombstone.subjectToken,
          tombstone.completionCertificateId,
          tombstone.targetNames,
          tombstone.createdAt,
          tombstone.completedAt,
        ],
      );
      await client.query(
        `UPDATE learning.privacy_tasks
         SET status='completed',attempts=$2,error_code=NULL,target_receipts=$3,
             download=NULL,updated_at=$4,completed_at=$5
         WHERE id=$1 AND status <> 'completed'`,
        [
          completedTask.id,
          completedTask.attempts,
          completedTask.targetReceipts,
          completedTask.updatedAt,
          completedTask.completedAt,
        ],
      );
    });
  }
  #select() {
    return `SELECT id,family_space_id,learning_profile_id,kind,status,attempts,error_code,target_receipts,download,requested_by_guardian_id,created_at,updated_at,deadline_at,completed_at FROM learning.privacy_tasks`;
  }
  async #withWorker<Value>(
    operation: (client: PoolClient) => Promise<Value>,
    scope?: { familySpaceId: string },
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.databaseRole}`);
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      if (scope) {
        await client.query(`SELECT set_config('rhea.family_space_id',$1,true)`, [
          scope.familySpaceId,
        ]);
      }
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
}

export type ExternalErasureHandler = (
  input: PrivacyScope & { target: ErasureTarget },
) => Promise<{ receipt: string }>;
export type TombstoneArchiveHandler = (tombstone: ErasureTombstone) => Promise<void>;

export class PostgresPrivacyDataPort implements PrivacyDataPort {
  readonly #key: Buffer;
  constructor(
    readonly pool: Pool,
    exportEncryptionSecret: string,
    readonly externalHandlers: Partial<Record<ErasureTarget, ExternalErasureHandler>> = {},
    readonly tombstoneArchive?: TombstoneArchiveHandler,
    readonly metricsTokenPepper?: string,
    readonly databaseRole: 'rhea_privacy_api' | 'rhea_privacy_worker' = 'rhea_privacy_worker',
    readonly profileAssetStore?: ObjectStorePort,
  ) {
    if (exportEncryptionSecret.length < 24)
      throw new Error('Export encryption secret must contain at least 24 characters');
    this.#key = createHash('sha256').update(exportEncryptionSecret).digest();
  }
  async archiveTombstone(tombstone: ErasureTombstone): Promise<void> {
    if (!this.tombstoneArchive) throw new Error('ERASURE_LEDGER_HANDLER_REQUIRED');
    await this.tombstoneArchive(tombstone);
  }
  async freezeProfile(input: PrivacyScope): Promise<void> {
    await this.#withWorker(async (client) => {
      const result = await client.query<{ frozen: boolean }>(
        'SELECT learning.freeze_profile_for_erasure($1,$2) AS frozen',
        [input.familySpaceId, input.learningProfileId],
      );
      if (!result.rows[0]?.frozen) throw new Error('PROFILE_NOT_FOUND');
    });
  }
  async profileExists(input: PrivacyScope): Promise<boolean> {
    return this.#withWorker(async (client) => {
      const result = await client.query<{ allowed: boolean }>(
        'SELECT learning.privacy_profile_in_family($1,$2) AS allowed',
        [input.familySpaceId, input.learningProfileId],
      );
      return result.rows[0]?.allowed === true;
    });
  }
  async exportProfile(input: PrivacyScope & { taskId: string }) {
    const snapshot = await this.#withWorker(async (client) => {
      const [profile, objectKeys] = await Promise.all([
        client.query<{ payload: unknown }>(
          'SELECT learning.export_profile_data($1,$2) AS payload',
          [input.familySpaceId, input.learningProfileId],
        ),
        client.query<{ object_key: string }>(
          'SELECT object_key FROM learning.list_profile_object_keys($1,$2)',
          [input.familySpaceId, input.learningProfileId],
        ),
      ]);
      if (!profile.rows[0]?.payload) throw new Error('PROFILE_NOT_FOUND');
      return {
        objectKeys: objectKeys.rows.map(({ object_key }) => object_key),
        payload: profile.rows[0].payload,
      };
    });
    if (snapshot.objectKeys.length > 0 && !this.profileAssetStore) {
      throw new Error('PROFILE_ASSET_EXPORT_STORE_REQUIRED');
    }
    const sourceAssets = await Promise.all(
      snapshot.objectKeys.map(async (objectKey) => {
        const bytes = await this.profileAssetStore!.get(objectKey);
        if (!bytes) throw new Error(`PROFILE_ASSET_MISSING:${objectKey}`);
        return {
          contentBase64: Buffer.from(bytes).toString('base64'),
          objectKey,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
        };
      }),
    );
    const payload = {
      ...(snapshot.payload as Record<string, unknown>),
      formatVersion: 'rhea-profile-export-v3',
      sourceAssets,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const objectKey = `db-private-export/${input.taskId}.json.aesgcm`;
    const createdAt = new Date();
    await this.#withWorker(async (client) => {
      await client.query(
        `INSERT INTO learning.privacy_export_blobs
         (object_key,task_id,encrypted_payload,expires_at,created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (object_key) DO UPDATE SET
           encrypted_payload=EXCLUDED.encrypted_payload,
           expires_at=EXCLUDED.expires_at,
           created_at=EXCLUDED.created_at`,
        [objectKey, input.taskId, encrypted, new Date(createdAt.getTime() + 86_400_000), createdAt],
      );
    });
    return {
      contentTypes: [
        'profile',
        'learning_content',
        'assessments',
        'wrong_items',
        'review_cards',
        'challenges',
        'growth',
        'classification_history',
        'generated_source_edges',
        'source_history',
        'state_history',
        'source_assets',
      ],
      generatedAt: createdAt.toISOString(),
      objectKey,
      sourceHistoryIncluded: true as const,
      stateHistoryIncluded: true as const,
    };
  }
  async downloadExport(input: PrivacyScope & { taskId: string }) {
    return this.#withWorker(
      async (client) => {
        const result = await client.query<{
          created_at: Date;
          encrypted_payload: Buffer;
        }>(
          `SELECT blob.encrypted_payload,blob.created_at
         FROM learning.privacy_export_blobs blob
         JOIN learning.privacy_tasks task ON task.id=blob.task_id
         WHERE blob.task_id=$1 AND task.family_space_id=$2
           AND task.learning_profile_id=$3 AND task.kind='export'
           AND task.status='completed' AND blob.expires_at > now()`,
          [input.taskId, input.familySpaceId, input.learningProfileId],
        );
        const row = result.rows[0];
        if (!row || row.encrypted_payload.byteLength < 29) throw new Error('EXPORT_NOT_AVAILABLE');
        const iv = row.encrypted_payload.subarray(0, 12);
        const tag = row.encrypted_payload.subarray(12, 28);
        const ciphertext = row.encrypted_payload.subarray(28);
        const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return {
          fileName: `rhea-profile-${input.learningProfileId}.json`,
          generatedAt: row.created_at.toISOString(),
          payload: JSON.parse(plaintext.toString('utf8')) as unknown,
        };
      },
      { familySpaceId: input.familySpaceId },
    );
  }
  async purgeExpiredExports(): Promise<number> {
    return this.#withWorker(async (client) => {
      const result = await client.query<{ deleted: number }>(
        'SELECT learning.delete_expired_privacy_exports() AS deleted',
      );
      return result.rows[0]?.deleted ?? 0;
    });
  }
  async deleteTarget(input: PrivacyScope & { target: ErasureTarget }) {
    const external = this.externalHandlers[input.target];
    if (external) return external(input);
    return this.#withWorker(async (client) => {
      if (input.target === 'active_database') {
        if (!this.metricsTokenPepper || this.metricsTokenPepper.length < 24) {
          throw new Error('METRICS_ERASURE_TOKEN_UNAVAILABLE');
        }
        const familyToken = createHmac('sha256', this.metricsTokenPepper)
          .update(input.familySpaceId)
          .digest('hex');
        const profileToken = createHmac('sha256', this.metricsTokenPepper)
          .update(input.learningProfileId)
          .digest('hex');
        await client.query('SELECT metrics.erase_profile_learning_events($1,$2)', [
          familyToken,
          profileToken,
        ]);
        await client.query('SELECT safety.pseudonymize_profile_records($1,$2,$3)', [
          input.familySpaceId,
          input.learningProfileId,
          profileToken,
        ]);
        const result = await client.query<{ deleted: boolean }>(
          'SELECT learning.delete_profile_active_data($1,$2) AS deleted',
          [input.familySpaceId, input.learningProfileId],
        );
        if (!result.rows[0]?.deleted) throw new Error('ACTIVE_DATA_DELETE_NOT_VERIFIED');
        return { receipt: `active-database:${new Date().toISOString()}` };
      }
      if (input.target === 'key_wrap') {
        const result = await client.query<{ destroyed: boolean }>(
          'SELECT learning.destroy_profile_key_wrap($1) AS destroyed',
          [input.learningProfileId],
        );
        if (!result.rows[0]?.destroyed) throw new Error('KEY_WRAP_DELETE_NOT_VERIFIED');
        return { receipt: `key-wrap-destroyed:${new Date().toISOString()}` };
      }
      throw new Error(`ERASURE_HANDLER_REQUIRED:${input.target}`);
    });
  }
  async #withWorker<Value>(
    operation: (client: PoolClient) => Promise<Value>,
    scope?: { familySpaceId: string },
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.databaseRole}`);
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      if (scope) {
        await client.query(`SELECT set_config('rhea.family_space_id',$1,true)`, [
          scope.familySpaceId,
        ]);
      }
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
}

export function createPostgresPrivacyLifecycleStore(
  databaseUrl: string,
  exportEncryptionSecret?: string,
  metricsTokenPepper?: string,
  databaseRole: 'rhea_privacy_api' | 'rhea_privacy_worker' = 'rhea_privacy_worker',
) {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    data: exportEncryptionSecret
      ? new PostgresPrivacyDataPort(
          pool,
          exportEncryptionSecret,
          {},
          undefined,
          metricsTokenPepper,
          databaseRole,
        )
      : null,
    pool,
    store: new PostgresPrivacyLifecycleStore(pool, databaseRole),
  };
}
