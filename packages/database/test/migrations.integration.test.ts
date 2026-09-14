import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { applyMigrations, loadDefaultMigrations } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const database = pool
  ? {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ) {
        const result = await pool.query(sql, values);
        return { rows: result.rows as Row[] };
      },
    }
  : undefined;

afterAll(async () => {
  await pool?.end();
});

describeWithDatabase('PostgreSQL migrations', () => {
  it('run through the released 0005 boundary, upgrade, and repeat safely', async () => {
    if (!pool || !database) {
      return;
    }

    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rhea_safety') THEN
        CREATE ROLE rhea_safety NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END $$`);
    await pool.query('DROP SCHEMA IF EXISTS learning, safety, metrics CASCADE');
    await pool.query('DROP TABLE IF EXISTS public.rhea_schema_migrations');
    const migrations = await loadDefaultMigrations();

    const released = await applyMigrations(database, migrations.slice(0, 5));
    const upgraded = await applyMigrations(database, migrations);
    const repeated = await applyMigrations(database, migrations);
    const schemas = await pool.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name = ANY($1::text[])
       ORDER BY schema_name`,
      [['learning', 'metrics', 'safety']],
    );

    expect(released).toEqual({
      applied: ['0001', '0002', '0003', '0004', '0005'],
      skipped: [],
    });
    expect(upgraded).toEqual({
      applied: [
        '0006',
        '0007',
        '0008',
        '0009',
        '0010',
        '0011',
        '0012',
        '0013',
        '0014',
        '0015',
        '0016',
        '0017',
        '0018',
        '0019',
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
      ],
      skipped: ['0001', '0002', '0003', '0004', '0005'],
    });
    expect(repeated).toEqual({
      applied: [],
      skipped: [
        '0001',
        '0002',
        '0003',
        '0004',
        '0005',
        '0006',
        '0007',
        '0008',
        '0009',
        '0010',
        '0011',
        '0012',
        '0013',
        '0014',
        '0015',
        '0016',
        '0017',
        '0018',
        '0019',
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
      ],
    });
    expect(schemas.rows.map(({ schema_name }) => schema_name)).toEqual([
      'learning',
      'metrics',
      'safety',
    ]);
    const privileges = await pool.query<{
      audit_delete: boolean;
      audit_insert: boolean;
      classification_update: boolean;
      material_update: boolean;
    }>(`SELECT
      has_table_privilege('rhea_learning_app', 'learning.learning_access_audit', 'DELETE') AS audit_delete,
      has_table_privilege('rhea_learning_app', 'learning.learning_access_audit', 'INSERT') AS audit_insert,
      has_table_privilege('rhea_learning_app', 'learning.classification_versions', 'UPDATE') AS classification_update,
      has_table_privilege('rhea_learning_app', 'learning.learning_materials', 'UPDATE') AS material_update`);
    expect(privileges.rows[0]).toEqual({
      audit_delete: false,
      audit_insert: true,
      classification_update: false,
      material_update: true,
    });
    const privacyReader = await pool.query<{
      can_create_wrap: boolean;
      can_read_wrap: boolean;
      safety_is_reader: boolean;
    }>(`SELECT
      has_function_privilege(
        'rhea_profile_crypto_reader',
        'learning.create_profile_key_wrap(uuid,uuid,text,bytea)',
        'EXECUTE'
      ) AS can_create_wrap,
      has_function_privilege(
        'rhea_profile_crypto_reader',
        'learning.get_profile_key_wrap(uuid,uuid)',
        'EXECUTE'
      ) AS can_read_wrap,
      pg_has_role('rhea_safety','rhea_profile_crypto_reader','MEMBER') AS safety_is_reader`);
    expect(privacyReader.rows[0]).toEqual({
      can_create_wrap: false,
      can_read_wrap: true,
      safety_is_reader: true,
    });
    const boundaries = await pool.query<{
      classifier_case_insert: boolean;
      classifier_execute: boolean;
      provider_admin_update: boolean;
      support_direct_job_select: boolean;
      support_execute: boolean;
      unsafe_support_function_removed: boolean;
    }>(`SELECT
      has_table_privilege('rhea_safety_classifier','safety.cases','INSERT') AS classifier_case_insert,
      has_function_privilege('rhea_safety_classifier','safety.record_classification_and_case(jsonb,jsonb)','EXECUTE') AS classifier_execute,
      has_table_privilege('rhea_provider_governance_admin','metrics.provider_capabilities','UPDATE') AS provider_admin_update,
      has_table_privilege('rhea_support_reader','learning.processing_jobs','SELECT') AS support_direct_job_select,
      has_function_privilege('rhea_support_reader','safety.authorize_and_read_support_data(uuid,text,uuid,text,text,text)','EXECUTE') AS support_execute,
      to_regprocedure('safety.read_support_data(uuid,uuid,text,text)') IS NULL AS unsafe_support_function_removed`);
    expect(boundaries.rows[0]).toEqual({
      classifier_case_insert: false,
      classifier_execute: true,
      provider_admin_update: false,
      support_direct_job_select: false,
      support_execute: true,
      unsafe_support_function_removed: true,
    });

    const recoveryRequestId = crypto.randomUUID();
    const recoveryFamilySpaceId = crypto.randomUUID();
    const recoveryProfileId = crypto.randomUUID();
    const recoveryMaterialId = crypto.randomUUID();
    const recoveryClient = await pool.connect();
    try {
      await recoveryClient.query('BEGIN');
      await recoveryClient.query('SET LOCAL session_replication_role = replica');
      await recoveryClient.query(
        `INSERT INTO learning.family_spaces(id,name) VALUES($1,'Recovery integration family')`,
        [recoveryFamilySpaceId],
      );
      await recoveryClient.query(
        `INSERT INTO learning.learning_profiles(
          id,family_space_id,display_name,grade,pin_hash
        ) VALUES($1,$2,'Recovery learner',4,'not-a-real-pin-hash')`,
        [recoveryProfileId, recoveryFamilySpaceId],
      );
      await recoveryClient.query(
        `INSERT INTO learning.learning_materials(
          id,family_space_id,learning_profile_id,confirmed_content_version_id,
          source_hash,validity_epoch,created_at
        ) VALUES($1,$2,$3,$4,repeat('b',64),1,now())`,
        [recoveryMaterialId, recoveryFamilySpaceId, recoveryProfileId, crypto.randomUUID()],
      );
      await recoveryClient.query(
        `INSERT INTO learning.generated_learning_requests (
          id,family_space_id,learning_profile_id,material_id,idempotency_key,
          request_fingerprint,purpose,actor_type,actor_id,consent_revision,
          capability,source_snapshot,source_key,status,unavailable_reason,
          current_version_id,revealed_hint_level,processing_lease_expires_at,
          state_revision,latest_checks,model_runs,created_at,updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,repeat('a',64),'learning_pack','guardian',$6,1,
          NULL,'{}','recovery-source','generating',NULL,NULL,0,
          now() + interval '10 minutes',7,'[]','[]',now(),now()
        )`,
        [
          recoveryRequestId,
          recoveryFamilySpaceId,
          recoveryProfileId,
          recoveryMaterialId,
          `recovery-${recoveryRequestId}`,
          crypto.randomUUID(),
        ],
      );
      await recoveryClient.query('SET LOCAL session_replication_role = origin');
      await recoveryClient.query('SET LOCAL ROLE rhea_runtime_rebuilder');
      const rebuilt = await recoveryClient.query<{
        snapshot: { generatedLearning: Array<{ id: string; learningProfileId: string }> };
      }>('SELECT learning.read_runtime_rebuild_snapshot() AS snapshot');
      await recoveryClient.query('RESET ROLE');
      const durable = await recoveryClient.query<{
        processing_lease_expires_at: Date | null;
        state_revision: number;
        status: string;
      }>(
        `SELECT status,processing_lease_expires_at,state_revision
         FROM learning.generated_learning_requests WHERE id=$1`,
        [recoveryRequestId],
      );
      expect(rebuilt.rows[0]?.snapshot.generatedLearning).toContainEqual({
        id: recoveryRequestId,
        learningProfileId: recoveryProfileId,
      });
      expect(durable.rows[0]).toEqual({
        processing_lease_expires_at: null,
        state_revision: 8,
        status: 'queued',
      });
      await recoveryClient.query('ROLLBACK');
    } catch (error) {
      await recoveryClient.query('ROLLBACK');
      throw error;
    } finally {
      recoveryClient.release();
    }

    const guardianId = crypto.randomUUID();
    const familySpaceId = crypto.randomUUID();
    const learningProfileId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    await pool.query('INSERT INTO learning.guardians(id,identity_subject) VALUES($1,$2)', [
      guardianId,
      `support-integration-${guardianId}`,
    ]);
    await pool.query('INSERT INTO learning.family_spaces(id,name) VALUES($1,$2)', [
      familySpaceId,
      'Support integration family',
    ]);
    await pool.query(
      `INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash)
       VALUES($1,$2,'Learner',4,'not-a-real-pin-hash')`,
      [learningProfileId, familySpaceId],
    );
    const supportGrantCreatedAt = new Date();
    await pool.query('SELECT safety.api_create_support_grant($1::jsonb)', [
      JSON.stringify({
        allowedRecordIds: [],
        createdAt: supportGrantCreatedAt.toISOString(),
        createdByGuardianId: guardianId,
        expiresAt: new Date(supportGrantCreatedAt.getTime() + 4 * 60 * 60_000).toISOString(),
        familySpaceId,
        id: grantId,
        learningProfileId,
        reason: 'migration integration support check',
        scopes: ['technical_metadata'],
        supportPrincipalId: 'support-integration-operator',
      }),
    ]);
    const supportClient = await pool.connect();
    try {
      await supportClient.query('BEGIN');
      await supportClient.query('SET LOCAL ROLE rhea_support_reader');
      const supportDecision = await supportClient.query<{
        data: { allowed: boolean; record: unknown };
      }>(`SELECT safety.authorize_and_read_support_data($1,$2,$3,$4,$5,$6) AS data`, [
        grantId,
        'support-integration-operator',
        familySpaceId,
        'technical_metadata',
        null,
        'inspect technical metadata',
      ]);
      expect(supportDecision.rows[0]?.data).toMatchObject({
        allowed: true,
        record: { grade: 4 },
      });
      await supportClient.query('COMMIT');
    } catch (error) {
      await supportClient.query('ROLLBACK');
      throw error;
    } finally {
      supportClient.release();
    }
    await expect(
      pool.query('SELECT learning.freeze_profile_for_erasure($1,$2) AS frozen', [
        familySpaceId,
        learningProfileId,
      ]),
    ).resolves.toMatchObject({ rows: [{ frozen: true }] });
    const revokedGrant = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM safety.support_access_grants WHERE id=$1',
      [grantId],
    );
    expect(revokedGrant.rows[0]?.revoked_at).toBeInstanceOf(Date);
    const frozenSupportClient = await pool.connect();
    try {
      await frozenSupportClient.query('BEGIN');
      await frozenSupportClient.query('SET LOCAL ROLE rhea_support_reader');
      const frozenDecision = await frozenSupportClient.query<{
        data: { allowed: boolean; reason: string };
      }>(`SELECT safety.authorize_and_read_support_data($1,$2,$3,$4,$5,$6) AS data`, [
        grantId,
        'support-integration-operator',
        familySpaceId,
        'technical_metadata',
        null,
        'inspect after erasure freeze',
      ]);
      expect(frozenDecision.rows[0]?.data).toMatchObject({
        allowed: false,
        reason: 'profile_erasure_frozen',
      });
      await frozenSupportClient.query('COMMIT');
    } catch (error) {
      await frozenSupportClient.query('ROLLBACK');
      throw error;
    } finally {
      frozenSupportClient.release();
    }
    const supportAudit = await pool.query<{ allowed: boolean; count: string }>(
      'SELECT allowed,count(*) FROM safety.support_access_audit WHERE grant_id=$1 GROUP BY allowed ORDER BY allowed',
      [grantId],
    );
    expect(supportAudit.rows).toEqual([
      { allowed: false, count: '1' },
      { allowed: true, count: '1' },
    ]);
    await pool.query('DELETE FROM safety.support_access_audit WHERE grant_id=$1', [grantId]);
    await pool.query('DELETE FROM learning.family_spaces WHERE id=$1', [familySpaceId]);
    await pool.query('DELETE FROM learning.guardians WHERE id=$1', [guardianId]);
  });
});
