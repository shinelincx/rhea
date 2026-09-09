import { randomUUID } from 'node:crypto';

import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { FamilyAccessService } from '@rhea/family-access';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresFamilyAccessStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const store = databaseUrl ? new PostgresFamilyAccessStore({ pool: pool! }) : undefined;

beforeAll(async () => {
  if (!pool) {
    return;
  }
  const database = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) {
      const result = await pool.query(sql, values);
      return { rows: result.rows as Row[] };
    },
  };
  await applyMigrations(database, await loadDefaultMigrations());
});

afterAll(async () => {
  await pool?.end();
});

describeWithDatabase('PostgreSQL FamilyAccess adapter', () => {
  it('persists isolated families and issues a learner session through the public interface', async () => {
    if (!store) {
      return;
    }
    const familyAccess = new FamilyAccessService({
      identityProvider: {
        async verify(assertion) {
          return { subject: assertion };
        },
      },
      store,
    });
    const suffix = randomUUID();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: `guardian-${suffix}` });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '数据库测试家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 4,
      pin: '2468',
    });
    const device = await familyAccess.registerDevice({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      label: '家庭平板',
    });

    await expect(
      familyAccess.listDeviceProfiles({ deviceAccessToken: device.accessToken }),
    ).resolves.toEqual([profile]);
    const learner = await familyAccess.issueLearnerSession({
      deviceAccessToken: device.accessToken,
      learningProfileId: profile.id,
      pin: '2468',
    });
    await expect(
      familyAccess.authorize({
        accessToken: learner.accessToken,
        capability: 'data.export',
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('enforces family-space RLS for a non-owner database role', async () => {
    if (!pool || !store) {
      return;
    }
    const familyAccess = new FamilyAccessService({
      identityProvider: { verify: async (assertion) => ({ subject: assertion }) },
      store,
    });
    const guardian = await familyAccess.loginGuardian({
      identityAssertion: `rls-${randomUUID()}`,
    });
    const firstFamily = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '可见家庭',
    });
    const secondFamily = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '不可见家庭',
    });
    await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '可见档案',
      familySpaceId: firstFamily.id,
      grade: 2,
      pin: '2468',
    });
    await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '不可见档案',
      familySpaceId: secondFamily.id,
      grade: 2,
      pin: '2468',
    });

    await pool.query(`DO $$ BEGIN
      CREATE ROLE rhea_rls_test NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
    await pool.query('GRANT USAGE ON SCHEMA learning TO rhea_rls_test');
    await pool.query('GRANT SELECT ON learning.learning_profiles TO rhea_rls_test');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_rls_test');
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [firstFamily.id]);
      const visible = await client.query<{ family_space_id: string }>(
        'SELECT family_space_id FROM learning.learning_profiles',
      );
      expect(visible.rows.map(({ family_space_id }) => family_space_id)).toEqual([firstFamily.id]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
