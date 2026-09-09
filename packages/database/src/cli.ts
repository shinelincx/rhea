import process from 'node:process';

import { Pool } from 'pg';

import { applyMigrations, loadDefaultMigrations, type DatabaseClient } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({ connectionString: databaseUrl });
const database: DatabaseClient = {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ) {
    const result = await pool.query(sql, values);
    return { rows: result.rows as Row[] };
  },
};

try {
  const migrations = await loadDefaultMigrations();
  const result = await applyMigrations(database, migrations);
  console.log(JSON.stringify({ event: 'database_migrations_complete', ...result }));
} finally {
  await pool.end();
}
