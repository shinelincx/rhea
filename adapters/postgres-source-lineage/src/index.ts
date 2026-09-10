import type {
  ClaimRebuildInput,
  DerivedArtifactIdentity,
  DerivedArtifactRead,
  LineageCommandReceipt,
  LineageSaveResult,
  PublishArtifactInput,
  RebuildJob,
  RecordSourceRevisionInput,
  SettleRebuildInput,
  SourceIdentity,
  SourceLineageStore,
  SourceRevision,
} from '@rhea/source-lineage';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface LineageQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

function json<Value>(value: Value | string): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

interface ValueRow<Value> extends QueryResultRow {
  value: Value | string | null;
}

export async function recordSourceRevisionInTransaction(
  client: LineageQueryable,
  input: RecordSourceRevisionInput,
  receipt: LineageCommandReceipt,
): Promise<LineageSaveResult<SourceRevision>> {
  const result = await client.query<ValueRow<LineageSaveResult<SourceRevision>>>(
    `SELECT learning.record_source_revision(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     ) AS value`,
    [
      input.source.familySpaceId,
      input.source.learningProfileId,
      input.source.kind,
      input.source.id,
      input.version,
      input.expected?.epoch ?? null,
      input.expected?.version ?? null,
      input.reason,
      input.occurredAt,
      receipt.commandId,
      receipt.fingerprint,
    ],
  );
  return json(result.rows[0]!.value!);
}

export async function syncSourceRevisionInTransaction(
  client: LineageQueryable,
  input: Omit<RecordSourceRevisionInput, 'commandId' | 'expected'>,
): Promise<SourceRevision> {
  const result = await client.query<ValueRow<SourceRevision>>(
    `SELECT learning.sync_source_revision($1, $2, $3, $4, $5, $6, $7) AS value`,
    [
      input.source.familySpaceId,
      input.source.learningProfileId,
      input.source.kind,
      input.source.id,
      input.version,
      input.reason,
      input.occurredAt,
    ],
  );
  if (!result.rows[0]?.value) throw new Error('Source lineage synchronization conflicted');
  return json(result.rows[0].value);
}

export async function publishArtifactInTransaction(
  client: LineageQueryable,
  input: PublishArtifactInput,
  receipt: LineageCommandReceipt,
): Promise<LineageSaveResult<DerivedArtifactRead>> {
  const result = await client.query<ValueRow<LineageSaveResult<DerivedArtifactRead>>>(
    `SELECT learning.publish_derived_artifact(
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
     ) AS value`,
    [
      input.artifact.familySpaceId,
      input.artifact.learningProfileId,
      input.artifact.kind,
      input.artifact.id,
      input.artifact.version,
      input.artifact.rebuildable,
      input.expectedPreviousVersion,
      JSON.stringify(input.dependencies),
      input.occurredAt,
      receipt.commandId,
      receipt.fingerprint,
    ],
  );
  return json(result.rows[0]!.value!);
}

export class PostgresSourceLineageStore implements SourceLineageStore {
  constructor(private readonly pool: Pool) {}

  async claimRebuild(input: ClaimRebuildInput): Promise<RebuildJob | null> {
    return this.#withRole(async (client) => {
      const result = await client.query<ValueRow<RebuildJob>>(
        `SELECT learning.claim_lineage_rebuild($1, $2, $3) AS value`,
        [input.workerId, input.now, input.leaseUntil],
      );
      return result.rows[0]?.value ? json(result.rows[0].value) : null;
    });
  }

  async findArtifact(identity: DerivedArtifactIdentity): Promise<DerivedArtifactRead | null> {
    return this.#withScope(identity, async (client) => {
      const result = await client.query<ValueRow<DerivedArtifactRead>>(
        `SELECT learning.read_lineage_artifact($1, $2, $3, $4, $5) AS value`,
        [
          identity.familySpaceId,
          identity.learningProfileId,
          identity.kind,
          identity.id,
          identity.version,
        ],
      );
      return result.rows[0]?.value ? json(result.rows[0].value) : null;
    });
  }

  async listSourceHistory(source: SourceIdentity): Promise<SourceRevision[]> {
    return this.#withScope(source, async (client) => {
      const result = await client.query<ValueRow<SourceRevision[]>>(
        `SELECT learning.list_source_history($1, $2, $3, $4) AS value`,
        [source.familySpaceId, source.learningProfileId, source.kind, source.id],
      );
      return result.rows[0]?.value ? json(result.rows[0].value) : [];
    });
  }

  async publishArtifact(
    input: PublishArtifactInput,
    receipt: LineageCommandReceipt,
  ): Promise<LineageSaveResult<DerivedArtifactRead>> {
    return this.#withScope(input.artifact, (client) =>
      publishArtifactInTransaction(client, input, receipt),
    );
  }

  async recordSourceRevision(
    input: RecordSourceRevisionInput,
    receipt: LineageCommandReceipt,
  ): Promise<LineageSaveResult<SourceRevision>> {
    return this.#withScope(input.source, (client) =>
      recordSourceRevisionInTransaction(client, input, receipt),
    );
  }

  async settleRebuild(
    input: SettleRebuildInput,
    receipt: LineageCommandReceipt,
  ): Promise<'completed' | 'conflict' | 'duplicate' | 'idempotency_conflict' | 'retry_scheduled'> {
    return this.#withRole(async (client) => {
      const replacement = input.outcome === 'completed' ? input.replacement : null;
      const result = await client.query<{ value: string }>(
        `SELECT learning.settle_lineage_rebuild(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         ) AS value`,
        [
          input.jobId,
          input.workerId,
          input.outcome,
          input.now,
          input.outcome === 'failed' ? input.retryAt : null,
          input.outcome === 'failed' ? input.errorCode : null,
          replacement?.kind ?? null,
          replacement?.id ?? null,
          replacement?.version ?? null,
          receipt.commandId,
          receipt.fingerprint,
        ],
      );
      return result.rows[0]!.value as
        'completed' | 'conflict' | 'duplicate' | 'idempotency_conflict' | 'retry_scheduled';
    });
  }

  async #withScope<Value>(
    scope: { familySpaceId: string; learningProfileId: string },
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    return this.#withRole(async (client) => {
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        scope.familySpaceId,
      ]);
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        scope.learningProfileId,
      ]);
      return operation(client);
    });
  }

  async #withRole<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_lineage_runtime');
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresSourceLineageStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresSourceLineageStore(pool) };
}
