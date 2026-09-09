import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Migration {
  name: string;
  sql: string;
  version: string;
}

export interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_FILE = /^(?<version>\d+)_(?<name>[a-z0-9_]+)\.sql$/;

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => MIGRATION_FILE.test(filename))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => {
      const match = MIGRATION_FILE.exec(filename);
      if (!match?.groups) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }
      const { name, version } = match.groups;
      if (!name || !version) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }

      return {
        name: name.replaceAll('_', ' '),
        sql: await readFile(join(directory, filename), 'utf8'),
        version,
      };
    }),
  );
}

export function loadDefaultMigrations(): Promise<Migration[]> {
  return loadMigrations(DEFAULT_MIGRATIONS_DIRECTORY);
}

export async function applyMigrations(
  database: DatabaseClient,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  await database.query('BEGIN');
  try {
    await database.query(`
      CREATE TABLE IF NOT EXISTS public.rhea_schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await database.query(`SELECT pg_advisory_xact_lock(hashtext('rhea-schema-migrations'))`);

    const existing = await database.query<{ version: string }>(
      'SELECT version FROM public.rhea_schema_migrations ORDER BY version',
    );
    const appliedVersions = new Set(existing.rows.map(({ version }) => version));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        result.skipped.push(migration.version);
        continue;
      }

      await database.query(migration.sql);
      await database.query(
        `INSERT INTO public.rhea_schema_migrations (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name],
      );
      result.applied.push(migration.version);
    }

    await database.query('COMMIT');
    return result;
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
}
