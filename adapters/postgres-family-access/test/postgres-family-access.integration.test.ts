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
    const assertion = `guardian-${suffix}`;
    const guardian = await familyAccess.loginGuardian({ identityAssertion: assertion });
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
    await familyAccess.reverifyGuardian({
      accessToken: guardian.accessToken,
      identityAssertion: assertion,
    });
    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      granted: true,
      kind: 'photo_processing',
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
    await expect(
      familyAccess.requireConsent({
        accessToken: learner.accessToken,
        familySpaceId: family.id,
        kind: 'photo_processing',
      }),
    ).resolves.toMatchObject({ revision: 1, status: 'granted' });
  });

  it('enforces family-space RLS for a non-owner database role', async () => {
    if (!pool || !store) {
      return;
    }
    const familyAccess = new FamilyAccessService({
      identityProvider: { verify: async (assertion) => ({ subject: assertion }) },
      store,
    });
    const identityAssertion = `rls-${randomUUID()}`;
    const guardian = await familyAccess.loginGuardian({ identityAssertion });
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
    await familyAccess.reverifyGuardian({
      accessToken: guardian.accessToken,
      identityAssertion,
    });
    await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '不可见档案',
      familySpaceId: secondFamily.id,
      grade: 2,
      pin: '2468',
    });
    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: firstFamily.id,
      granted: true,
      kind: 'photo_processing',
    });
    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: secondFamily.id,
      granted: true,
      kind: 'ai_processing',
    });

    await pool.query(`DO $$ BEGIN
      CREATE ROLE rhea_rls_test NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
    await pool.query('GRANT USAGE ON SCHEMA learning TO rhea_rls_test');
    await pool.query('GRANT SELECT ON learning.learning_profiles TO rhea_rls_test');
    await pool.query('GRANT SELECT ON learning.family_consents TO rhea_rls_test');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_rls_test');
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [firstFamily.id]);
      const visible = await client.query<{ family_space_id: string }>(
        'SELECT family_space_id FROM learning.learning_profiles',
      );
      expect(visible.rows.map(({ family_space_id }) => family_space_id)).toEqual([firstFamily.id]);
      const visibleConsents = await client.query<{ family_space_id: string }>(
        'SELECT family_space_id FROM learning.family_consents',
      );
      expect(visibleConsents.rows.map(({ family_space_id }) => family_space_id)).toEqual([
        firstFamily.id,
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
