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
  it('run from an empty database and can be repeated safely', async () => {
    if (!pool || !database) {
      return;
    }

    await pool.query('DROP SCHEMA IF EXISTS learning, safety, metrics CASCADE');
    await pool.query('DROP TABLE IF EXISTS public.rhea_schema_migrations');
    const migrations = await loadDefaultMigrations();

    const first = await applyMigrations(database, migrations);
    const second = await applyMigrations(database, migrations);
    const schemas = await pool.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name = ANY($1::text[])
       ORDER BY schema_name`,
      [['learning', 'metrics', 'safety']],
    );

    expect(first).toEqual({ applied: ['0001', '0002', '0003', '0004', '0005'], skipped: [] });
    expect(second).toEqual({ applied: [], skipped: ['0001', '0002', '0003', '0004', '0005'] });
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
  });
});
