import { createHash, randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { PrivacyLifecycleService, type ErasureTombstone } from '@rhea/privacy-lifecycle';
import type { ObjectStorePort } from '@rhea/submission';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresPrivacyDataPort,
  PostgresPrivacyLifecycleStore,
  PostgresProfileEnvelopeObjectStore,
} from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeWithDatabase('Postgres privacy lifecycle adapter', () => {
  const familySpaceId = randomUUID();
  const guardianId = randomUUID();
  const profileId = randomUUID();
  beforeAll(async () => {
    await applyMigrations(
      {
        query: async (sql, values) => {
          const result = await pool!.query(sql, values);
          return { rows: result.rows };
        },
      },
      await loadDefaultMigrations(),
    );
    await pool!.query('INSERT INTO learning.family_spaces(id,name) VALUES($1,$2)', [
      familySpaceId,
      '隐私集成家庭',
    ]);
    await pool!.query('INSERT INTO learning.guardians(id,identity_subject) VALUES($1,$2)', [
      guardianId,
      `privacy-${guardianId}`,
    ]);
    await pool!.query(
      "INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash) VALUES($1,$2,'小禾',4,'hash')",
      [profileId, familySpaceId],
    );
  });
  afterAll(async () => {
    await pool?.query(
      'DELETE FROM learning.erasure_tombstones WHERE task_id IN (SELECT id FROM learning.privacy_tasks WHERE family_space_id=$1)',
      [familySpaceId],
    );
    await pool?.query(
      'DELETE FROM learning.erasure_certificates WHERE task_id IN (SELECT id FROM learning.privacy_tasks WHERE family_space_id=$1)',
      [familySpaceId],
    );
    await pool?.query(
      'DELETE FROM learning.privacy_export_blobs WHERE task_id IN (SELECT id FROM learning.privacy_tasks WHERE family_space_id=$1)',
      [familySpaceId],
    );
    await pool?.query('DELETE FROM learning.privacy_tasks WHERE family_space_id=$1', [
      familySpaceId,
    ]);
    await pool?.query('DELETE FROM learning.family_spaces WHERE id=$1', [familySpaceId]);
    await pool?.query('DELETE FROM learning.guardians WHERE id=$1', [guardianId]);
    await pool?.end();
  });

  it('serializes ordinary profile writes behind the erasure freeze fence', async () => {
    const concurrentFamilyId = randomUUID();
    const concurrentProfileId = randomUUID();
    await pool!.query('INSERT INTO learning.family_spaces(id,name) VALUES($1,$2)', [
      concurrentFamilyId,
      '冻结并发测试家庭',
    ]);
    await pool!.query(
      "INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash) VALUES($1,$2,'并发测试',4,'hash')",
      [concurrentProfileId, concurrentFamilyId],
    );

    const freezer = await pool!.connect();
    try {
      await freezer.query('BEGIN');
      await freezer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        concurrentProfileId,
      ]);
      let insertSettled = false;
      const insertAttempt = pool!
        .query(
          `INSERT INTO learning.upload_sessions
             (id,family_space_id,learning_profile_id,status,created_at,expires_at)
           VALUES ($1,$2,$3,'open',now(),now()+interval '10 minutes')`,
          [randomUUID(), concurrentFamilyId, concurrentProfileId],
        )
        .finally(() => {
          insertSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(insertSettled).toBe(false);
      await freezer.query('SELECT learning.freeze_profile_for_erasure($1,$2)', [
        concurrentFamilyId,
        concurrentProfileId,
      ]);
      await freezer.query('COMMIT');
      await expect(insertAttempt).rejects.toThrow('PROFILE_FROZEN_FOR_ERASURE');
      expect(
        (
          await pool!.query(
            "SELECT count(*)::integer AS count FROM learning.upload_sessions WHERE learning_profile_id=$1 AND status='open'",
            [concurrentProfileId],
          )
        ).rows[0],
      ).toEqual({ count: 0 });
    } catch (error) {
      await freezer.query('ROLLBACK');
      throw error;
    } finally {
      freezer.release();
      await pool!.query('DELETE FROM learning.family_spaces WHERE id=$1', [concurrentFamilyId]);
    }
  });

  it('encrypts exports, deletes all targets and re-deletes a profile resurrected by restore', async () => {
    const encryptedObjects = new Map<string, Uint8Array>();
    let blockedPutKey: string | null = null;
    const putStarted = deferred();
    const putReleased = deferred();
    const rawObjectStore: ObjectStorePort = {
      async delete(key) {
        encryptedObjects.delete(key);
        return { proof: 'memory:deleted' };
      },
      async get(key) {
        return encryptedObjects.get(key) ?? null;
      },
      async put(key, bytes) {
        if (key === blockedPutKey) {
          putStarted.resolve();
          await putReleased.promise;
        }
        encryptedObjects.set(key, Uint8Array.from(bytes));
      },
    };
    const envelopeStore = new PostgresProfileEnvelopeObjectStore(
      pool!,
      rawObjectStore,
      'profile-envelope-test-kek-at-least-32-characters',
      'kms-test-key',
    );
    const objectKey = `ingest-temporary/${familySpaceId}/${profileId}/page-1`;
    const originalAsset = Buffer.from('child worksheet bytes');
    await envelopeStore.put(objectKey, originalAsset);
    const exportUploadSessionId = randomUUID();
    await pool!.query(
      `INSERT INTO learning.upload_sessions
         (id,family_space_id,learning_profile_id,status,created_at,expires_at)
       VALUES ($1,$2,$3,'submitted',now(),now()+interval '10 minutes')`,
      [exportUploadSessionId, familySpaceId, profileId],
    );
    await pool!.query(
      `INSERT INTO learning.upload_pages
         (id,upload_session_id,learning_profile_id,file_name,declared_mime_type,
          observed_mime_type,size_bytes,sha256,page_order,rotation,crop,width,height,
          object_key,upload_token_hash,uploaded_at)
       VALUES ($1,$2,$3,'worksheet.jpg','image/jpeg','image/jpeg',$4,$5,0,0,NULL,100,100,
               $6,'test-upload-token',now())`,
      [
        randomUUID(),
        exportUploadSessionId,
        profileId,
        originalAsset.byteLength,
        createHash('sha256').update(originalAsset).digest('hex'),
        objectKey,
      ],
    );
    expect(Buffer.from(encryptedObjects.get(objectKey)!).toString('utf8')).not.toContain(
      'child worksheet bytes',
    );
    await expect(envelopeStore.get(objectKey)).resolves.toEqual(
      Buffer.from('child worksheet bytes'),
    );
    const legacyObjectKey = `ingest-temporary/${profileId}/${randomUUID()}/page-1`;
    encryptedObjects.set(legacyObjectKey, Buffer.from('legacy worksheet bytes'));
    await expect(envelopeStore.get(legacyObjectKey)).resolves.toEqual(
      Buffer.from('legacy worksheet bytes'),
    );
    const exportAssetStore = new PostgresProfileEnvelopeObjectStore(
      pool!,
      rawObjectStore,
      'profile-envelope-test-kek-at-least-32-characters',
      'kms-test-key',
      'read-only',
    );
    await expect(exportAssetStore.get(objectKey)).resolves.toEqual(originalAsset);
    await expect(exportAssetStore.get(legacyObjectKey)).resolves.toEqual(
      Buffer.from('legacy worksheet bytes'),
    );
    await expect(exportAssetStore.put(objectKey, Buffer.from('forbidden rewrite'))).rejects.toThrow(
      'PROFILE_OBJECT_STORE_READ_ONLY',
    );
    expect(
      Buffer.from(encryptedObjects.get(legacyObjectKey)!).subarray(0, 8).toString('ascii'),
    ).toBe('RHEAENV1');
    await expect(envelopeStore.get(legacyObjectKey)).resolves.toEqual(
      Buffer.from('legacy worksheet bytes'),
    );

    const archivedTombstones: ErasureTombstone[] = [];
    const store = new PostgresPrivacyLifecycleStore(pool!);
    const data = new PostgresPrivacyDataPort(
      pool!,
      'privacy-export-encryption-secret-32-bytes',
      {
        cache: async () => ({ receipt: 'cache:deleted' }),
        object_storage: async () => {
          encryptedObjects.clear();
          return { receipt: 'object:deleted' };
        },
        vendor_copies: async () => ({ receipt: 'vendor:deleted' }),
      },
      async (tombstone) => {
        archivedTombstones.push(structuredClone(tombstone));
      },
      undefined,
      'rhea_privacy_worker',
      exportAssetStore,
    );
    const service = new PrivacyLifecycleService(
      store,
      data,
      'privacy-tombstone-integration-pepper-32-bytes',
    );
    const exported = await service.requestExport({
      familySpaceId,
      learningProfileId: profileId,
      requestedByGuardianId: guardianId,
    });
    expect((await service.processTask(exported.id)).status).toBe('completed');
    await expect(
      service.requestExport({
        familySpaceId: randomUUID(),
        learningProfileId: profileId,
        requestedByGuardianId: guardianId,
      }),
    ).rejects.toMatchObject({ code: 'PRIVACY_TASK_NOT_FOUND' });
    await expect(
      service.downloadExport({ familySpaceId, learningProfileId: profileId, taskId: exported.id }),
    ).resolves.toMatchObject({
      fileName: `rhea-profile-${profileId}.json`,
      payload: {
        formatVersion: 'rhea-profile-export-v3',
        profile: { display_name: '小禾', id: profileId },
        sourceAssets: [
          {
            contentBase64: originalAsset.toString('base64'),
            objectKey,
            sha256: createHash('sha256').update(originalAsset).digest('hex'),
            sizeBytes: originalAsset.byteLength,
          },
        ],
      },
    });
    const blob = await pool!.query(
      'SELECT encrypted_payload FROM learning.privacy_export_blobs WHERE task_id=$1',
      [exported.id],
    );
    expect(blob.rows[0]?.encrypted_payload).toBeInstanceOf(Buffer);
    expect(blob.rows[0]?.encrypted_payload.toString('utf8')).not.toContain('小禾');

    const openUploadId = randomUUID();
    await pool!.query(
      `INSERT INTO learning.upload_sessions
         (id,family_space_id,learning_profile_id,status,created_at,expires_at)
       VALUES ($1,$2,$3,'open',now(),now()+interval '10 minutes')`,
      [openUploadId, familySpaceId, profileId],
    );
    const racingObjectKey = `ingest-temporary/${familySpaceId}/${profileId}/racing-page`;
    blockedPutKey = racingObjectKey;
    const racingPut = envelopeStore.put(racingObjectKey, Buffer.from('racing upload'));
    await putStarted.promise;
    const preview = service.previewErasure({ familySpaceId, learningProfileId: profileId });
    let freezeSettled = false;
    const erasureRequest = service
      .requestErasure({
        confirmationText: preview.confirmationText,
        familySpaceId,
        learningProfileId: profileId,
        requestedByGuardianId: guardianId,
      })
      .finally(() => {
        freezeSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(freezeSettled).toBe(false);
    putReleased.resolve();
    await racingPut;
    const erasure = await erasureRequest;
    expect(
      (await pool!.query('SELECT status FROM learning.upload_sessions WHERE id=$1', [openUploadId]))
        .rows[0],
    ).toEqual({ status: 'canceled' });
    await expect(envelopeStore.put(racingObjectKey, Buffer.from('late upload'))).rejects.toThrow(
      'PROFILE_FROZEN_FOR_ERASURE',
    );
    const frozenLegacyObjectKey = `ingest-temporary/${profileId}/${randomUUID()}/page-2`;
    const frozenLegacyBytes = Buffer.from('must never be rewritten after freeze');
    encryptedObjects.set(frozenLegacyObjectKey, frozenLegacyBytes);
    await expect(envelopeStore.get(frozenLegacyObjectKey)).rejects.toThrow(
      'PROFILE_FROZEN_FOR_ERASURE',
    );
    expect(encryptedObjects.get(frozenLegacyObjectKey)).toEqual(frozenLegacyBytes);
    await expect(
      pool!.query(
        `INSERT INTO learning.upload_sessions
           (id,family_space_id,learning_profile_id,status,created_at,expires_at)
         VALUES ($1,$2,$3,'open',now(),now()+interval '10 minutes')`,
        [randomUUID(), familySpaceId, profileId],
      ),
    ).rejects.toThrow('PROFILE_FROZEN_FOR_ERASURE');
    expect((await service.processTask(erasure.id)).status).toBe('completed');
    expect((await service.processTask(erasure.id)).status).toBe('completed');
    expect(archivedTombstones).toHaveLength(1);
    expect(encryptedObjects.has(racingObjectKey)).toBe(false);
    await expect(envelopeStore.get(objectKey)).rejects.toThrow('PROFILE_KEY_UNAVAILABLE');
    expect(
      (await pool!.query('SELECT 1 FROM learning.learning_profiles WHERE id=$1', [profileId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool!.query('SELECT 1 FROM learning.privacy_export_blobs WHERE task_id=$1', [
          exported.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool!.query(
          'SELECT subject_token FROM learning.erasure_tombstones WHERE task_id=$1',
          [erasure.id],
        )
      ).rows[0],
    ).toMatchObject({ subject_token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(
      (
        await pool!.query(
          'SELECT count(*)::integer AS count FROM learning.erasure_certificates WHERE task_id=$1',
          [erasure.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    await pool!.query(
      "INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash) VALUES($1,$2,'恢复副本',4,'hash')",
      [profileId, familySpaceId],
    );
    expect(
      await service.replayTombstones([{ familySpaceId, learningProfileId: profileId }]),
    ).toEqual([{ familySpaceId, learningProfileId: profileId }]);
    expect(
      (await pool!.query('SELECT 1 FROM learning.learning_profiles WHERE id=$1', [profileId]))
        .rowCount,
    ).toBe(0);
  });
});
