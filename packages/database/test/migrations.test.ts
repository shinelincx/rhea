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

    expect(migrations.map(({ version }) => version)).toEqual(['0001']);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS learning/i);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS safety/i);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS metrics/i);
  });
});
