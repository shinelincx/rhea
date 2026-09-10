import { describe, expect, it } from 'vitest';

import {
  applyMigrations,
  loadDefaultMigrations,
  type DatabaseClient,
  type Migration,
} from '../src/index.js';

class RecordingDatabase implements DatabaseClient {
  readonly applied = new Set<string>();
  readonly executedMigrationSql: string[] = [];
  readonly transactions: string[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    const normalized = sql.trim().toUpperCase();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      this.transactions.push(normalized);
    } else if (normalized.startsWith('SELECT VERSION')) {
      return {
        rows: [...this.applied].map((version) => ({ version })) as unknown as Row[],
      };
    } else if (normalized.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) {
      return { rows: [] };
    } else if (normalized.startsWith('INSERT INTO PUBLIC.RHEA_SCHEMA_MIGRATIONS')) {
      this.applied.add(String(values[0]));
    } else if (!normalized.startsWith('CREATE TABLE IF NOT EXISTS PUBLIC.RHEA_SCHEMA_MIGRATIONS')) {
      this.executedMigrationSql.push(sql);
    }

    return { rows: [] };
  }
}

describe('database migration interface', () => {
  it('applies an ordered migration once and safely skips it on a repeat run', async () => {
    const database = new RecordingDatabase();
    const migrations: Migration[] = [
      {
        name: 'base schemas',
        sql: 'CREATE SCHEMA IF NOT EXISTS learning;',
        version: '0001',
      },
    ];

    const first = await applyMigrations(database, migrations);
    const second = await applyMigrations(database, migrations);

    expect(first).toEqual({ applied: ['0001'], skipped: [] });
    expect(second).toEqual({ applied: [], skipped: ['0001'] });
    expect(database.executedMigrationSql).toEqual(['CREATE SCHEMA IF NOT EXISTS learning;']);
    expect(database.transactions).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  });

  it('ships an initial migration that owns the three approved data schemas', async () => {
    const migrations = await loadDefaultMigrations();

    expect(migrations.map(({ version }) => version)).toEqual([
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
    ]);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS learning/i);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS safety/i);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS metrics/i);
    expect(migrations[3]?.sql).toMatch(/CREATE TABLE learning\.processing_jobs/i);
    expect(migrations[3]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migrations[7]?.sql).toMatch(/CREATE TABLE learning\.objective_assessments/i);
    expect(migrations[7]?.sql).toMatch(/CREATE TABLE learning\.objective_grading_rule_versions/i);
    expect(migrations[7]?.sql).toMatch(/CREATE ROLE rhea_assessment_app/i);
    expect(migrations[3]?.sql).not.toMatch(
      /FUNCTION learning\.resolve_confirmed_objective_regions/i,
    );
    expect(migrations[4]?.sql).not.toMatch(
      /FUNCTION learning\.resolve_objective_assessment_basis/i,
    );
    expect(migrations[5]?.sql).toMatch(/FUNCTION learning\.resolve_confirmed_objective_regions/i);
    expect(migrations[5]?.sql).toMatch(/questionRegionId/i);
    expect(migrations[6]?.sql).toMatch(/FUNCTION learning\.resolve_objective_assessment_basis/i);
    expect(migrations[6]?.sql).toMatch(/FUNCTION learning\.lock_current_assessment_basis/i);
    expect(migrations[6]?.sql).toMatch(/SECURITY DEFINER/i);
    expect(migrations[6]?.sql).toMatch(
      /REVOKE ALL ON FUNCTION learning\.lock_current_assessment_basis/i,
    );
    expect(migrations[7]?.sql).toMatch(/FUNCTION learning\.resolve_objective_assessment_input/i);
    expect(migrations[7]?.sql).toMatch(/FUNCTION learning\.confirm_objective_grading_rule/i);
    expect(migrations[7]?.sql).toMatch(
      /REVOKE ALL ON FUNCTION learning\.confirm_objective_grading_rule/i,
    );
    expect(migrations[7]?.sql).toMatch(/input_authority jsonb NOT NULL/i);
    expect(migrations[7]?.sql).toMatch(/resolved_by_type IN \('guardian', 'professional'\)/i);
    expect(migrations[7]?.sql).toMatch(/SET search_path = pg_catalog, learning/i);
    expect(migrations[7]?.sql).not.toMatch(
      /(?:FROM|JOIN) learning\.(?:confirmed_content_versions|classification_versions|basis_selection_versions|learning_source_versions)/i,
    );
    expect(migrations[7]?.sql).toMatch(
      /ALTER TABLE learning\.objective_grading_rule_versions FORCE ROW LEVEL SECURITY/i,
    );
    expect(migrations[8]?.sql).toMatch(
      /FUNCTION learning\.lock_current_generated_learning_eligibility/i,
    );
    expect(migrations[9]?.sql).toMatch(
      /FUNCTION learning\.lock_current_generated_learning_content/i,
    );
    expect(migrations[10]?.sql).toMatch(
      /FUNCTION learning\.lock_current_generated_learning_basis/i,
    );
    expect(migrations[11]?.sql).toMatch(/CREATE ROLE rhea_generated_learning_app/i);
    expect(migrations[11]?.sql).toMatch(/FUNCTION learning\.lock_generated_learning_publication/i);
  });

  it('upgrades a database recorded at 0005 without rewriting released migrations', async () => {
    const database = new RecordingDatabase();
    for (const version of ['0001', '0002', '0003', '0004', '0005']) {
      database.applied.add(version);
    }

    const result = await applyMigrations(database, await loadDefaultMigrations());

    expect(result).toEqual({
      applied: ['0006', '0007', '0008', '0009', '0010', '0011', '0012'],
      skipped: ['0001', '0002', '0003', '0004', '0005'],
    });
    expect(database.executedMigrationSql).toHaveLength(7);
  });
});
