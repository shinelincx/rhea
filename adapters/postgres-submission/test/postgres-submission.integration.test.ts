import { createHash, randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import {
  MemoryObjectStore,
  SubmissionService,
  deterministicFileInspection,
  deterministicRecognition,
} from '@rhea/submission';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSubmissionStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (pool) {
    await applyMigrations(pool, await loadDefaultMigrations());
  }
});

afterAll(async () => pool?.end());

describeWithDatabase('PostgreSQL submission adapter', () => {
  it('persists immutable candidate lineage and profile-isolated job state', async () => {
    if (!pool) return;
    const familySpaceId = randomUUID();
    const learningProfileId = randomUUID();
    const setupClient = await pool.connect();
    try {
      await setupClient.query('BEGIN');
      await setupClient.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        familySpaceId,
      ]);
      await setupClient.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
        familySpaceId,
        '识别适配器测试',
      ]);
      await setupClient.query(
        `INSERT INTO learning.learning_profiles
          (id, family_space_id, display_name, grade, pin_hash)
         VALUES ($1, $2, $3, 3, $4)`,
        [learningProfileId, familySpaceId, '小禾', 'test-hash'],
      );
      await setupClient.query('COMMIT');
    } catch (error) {
      await setupClient.query('ROLLBACK');
      throw error;
    } finally {
      setupClient.release();
    }
    const store = new PostgresSubmissionStore(pool);
    const service = new SubmissionService({
      fileInspection: deterministicFileInspection,
      objectStore: new MemoryObjectStore(),
      rawAssetDeletions: store,
      recognition: deterministicRecognition,
      store,
    });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
    const pageId = randomUUID();
    const upload = await service.createUploadSession({
      familySpaceId,
      learningProfileId,
      pages: [
        {
          crop: null,
          fileName: '练习.jpg',
          height: 1_600,
          id: pageId,
          mimeType: 'image/jpeg',
          order: 0,
          rotation: 0,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          width: 1_200,
        },
      ],
    });
    await service.uploadPage({
      bytes,
      learningProfileId,
      pageId,
      token: upload.pages[0]!.uploadToken,
      uploadSessionId: upload.id,
    });
    const queued = await service.submit({ learningProfileId, uploadSessionId: upload.id });
    const recognized = await service.process(queued.id, learningProfileId);
    const confirmed = await service.confirm({
      edits: {},
      id: queued.id,
      learningProfileId,
    });

    expect(recognized.candidate).not.toBeNull();
    expect(confirmed.completedContent).toMatchObject({
      sourceCandidateId: recognized.candidate?.id,
      sourceHash: recognized.candidate?.sourceHash,
    });
    await expect(
      service.getJob({ id: queued.id, learningProfileId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  });
});
