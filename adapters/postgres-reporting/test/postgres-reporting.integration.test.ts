import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { FamilyAccessService } from '@rhea/family-access';
import { PostgresFamilyAccessStore } from '@rhea/postgres-family-access';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresReportingStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

beforeAll(async () => {
  if (!pool) return;
  await applyMigrations(
    {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ) {
        const result = await pool.query(sql, values);
        return { rows: result.rows as Row[] };
      },
    },
    await loadDefaultMigrations(),
  );
});

afterAll(async () => {
  await pool?.end();
});

describeWithDatabase('PostgreSQL Reporting adapter', () => {
  it('reads only the requested profile through its read-only role', async () => {
    if (!pool) return;
    const familyAccess = new FamilyAccessService({
      identityProvider: {
        async verify(assertion) {
          return { subject: assertion };
        },
      },
      store: new PostgresFamilyAccessStore({ pool }),
    });
    const assertion = `reporting-${randomUUID()}`;
    const guardian = await familyAccess.loginGuardian({ identityAssertion: assertion });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '报告测试家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 4,
      pin: '2468',
    });
    const sibling = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小苗',
      familySpaceId: family.id,
      grade: 2,
      pin: '1357',
    });
    const uploadId = randomUUID();
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO learning.upload_sessions
         (id, family_space_id, learning_profile_id, status, job_id, created_at, expires_at)
       VALUES ($1, $2, $3, 'submitted', NULL, $4, $5)`,
      [uploadId, family.id, profile.id, '2026-09-15T00:00:00.000Z', '2026-09-16T00:00:00.000Z'],
    );
    await pool.query(
      `INSERT INTO learning.processing_jobs
         (id, upload_session_id, family_space_id, learning_profile_id, status,
          revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'awaiting_confirmation', 1, $5, $5)`,
      [jobId, uploadId, family.id, profile.id, '2026-09-15T00:01:00.000Z'],
    );
    await pool.query(`UPDATE learning.upload_sessions SET job_id = $1 WHERE id = $2`, [
      jobId,
      uploadId,
    ]);

    const store = new PostgresReportingStore(pool);
    const route = await store.readTodayRouteCandidates(
      { familySpaceId: family.id, learningProfileId: profile.id },
      '2026-09-15T01:00:00.000Z',
    );
    expect(route).toMatchObject([
      {
        actionTargetId: jobId,
        kind: 'content_confirmation',
        source: { authorityState: 'pending' },
      },
    ]);
    await expect(
      store.readTodayRouteCandidates(
        { familySpaceId: family.id, learningProfileId: sibling.id },
        '2026-09-15T01:00:00.000Z',
      ),
    ).resolves.toEqual([]);
    await expect(
      store.readGuardianTodoCandidates({
        familySpaceId: family.id,
        learningProfileId: profile.id,
      }),
    ).resolves.toMatchObject([
      { kind: 'authorization' },
      { kind: 'authorization' },
      { kind: 'authorization' },
      { kind: 'authorization' },
    ]);
    await expect(
      store.readLearningReportFacts(
        { familySpaceId: family.id, learningProfileId: profile.id },
        { from: '2026-08-19T00:00:00.000Z', to: '2026-09-15T01:00:00.000Z' },
      ),
    ).resolves.toEqual({ evidence: [], exclusions: [], themeStates: [], wrongItemChanges: [] });

    const privileges = await pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(`SELECT
      has_table_privilege('rhea_reporting_app', 'learning.learning_evidence', 'SELECT') AS can_select,
      has_table_privilege('rhea_reporting_app', 'learning.learning_evidence', 'INSERT') AS can_insert,
      has_table_privilege('rhea_reporting_app', 'learning.learning_evidence', 'UPDATE') AS can_update,
      has_table_privilege('rhea_reporting_app', 'learning.learning_evidence', 'DELETE') AS can_delete`);
    expect(privileges.rows[0]).toEqual({
      can_delete: false,
      can_insert: false,
      can_select: true,
      can_update: false,
    });
  });
});
