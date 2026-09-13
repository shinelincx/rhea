import type {
  EgressAuditRecord,
  ProviderCapability,
  ProviderGovernanceStore,
} from '@rhea/provider-governance';
import { providerCapabilitiesEqual } from '@rhea/provider-governance';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
interface CapabilityRow extends QueryResultRow {
  allowed_data_categories: ProviderCapability['allowedDataCategories'];
  allowed_origins: string[];
  capability_version_id: string;
  contract: ProviderCapability['contract'];
  enabled: boolean;
  kind: ProviderCapability['kind'];
  provider_id: string;
  region: ProviderCapability['region'];
}
function capability(row: CapabilityRow): ProviderCapability {
  return {
    allowedDataCategories: row.allowed_data_categories,
    allowedOrigins: row.allowed_origins,
    capabilityVersionId: row.capability_version_id,
    contract: row.contract,
    enabled: row.enabled,
    kind: row.kind,
    providerId: row.provider_id,
    region: row.region,
  };
}
export class PostgresProviderGovernanceStore implements ProviderGovernanceStore {
  constructor(
    readonly pool: Pool,
    readonly databaseRole:
      'rhea_provider_gateway' | 'rhea_provider_governance_admin' = 'rhea_provider_gateway',
  ) {}
  async findCapability(id: string) {
    return this.#with(async (client) => {
      const result = await client.query<CapabilityRow>(
        'SELECT capability_version_id,provider_id,kind,region,allowed_origins,allowed_data_categories,contract,enabled FROM metrics.provider_capabilities WHERE capability_version_id=$1',
        [id],
      );
      const row = result.rows[0];
      return row ? capability(row) : null;
    });
  }
  async saveCapability(value: ProviderCapability) {
    await this.#with((client) => this.#saveCapability(client, value));
  }
  async saveCapabilitiesAtomically(values: ProviderCapability[]) {
    await this.#with(async (client) => {
      for (const value of values) await this.#saveCapability(client, value);
    });
  }
  async #saveCapability(client: PoolClient, value: ProviderCapability) {
    const inserted = await client.query(
      `INSERT INTO metrics.provider_capabilities(capability_version_id,provider_id,kind,region,allowed_origins,allowed_data_categories,contract,enabled,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())ON CONFLICT(capability_version_id)DO NOTHING`,
      [
        value.capabilityVersionId,
        value.providerId,
        value.kind,
        value.region,
        value.allowedOrigins,
        value.allowedDataCategories,
        value.contract,
        value.enabled,
      ],
    );
    if (inserted.rowCount === 1) return;
    const existing = await client.query<CapabilityRow>(
      'SELECT capability_version_id,provider_id,kind,region,allowed_origins,allowed_data_categories,contract,enabled FROM metrics.provider_capabilities WHERE capability_version_id=$1',
      [value.capabilityVersionId],
    );
    const row = existing.rows[0];
    if (!row || !providerCapabilitiesEqual(capability(row), value)) {
      throw new Error('PROVIDER_CAPABILITY_VERSION_CONFLICT');
    }
  }
  async recordEgress(value: EgressAuditRecord) {
    await this.#with((client) =>
      client
        .query(
          `INSERT INTO metrics.provider_egress_audit(request_id,capability_version_id,provider_id,purpose,region,destination_origin,data_categories,payload_hash,response_hash,outcome,finished_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            value.requestId,
            value.capabilityVersionId,
            value.providerId,
            value.purpose,
            value.region,
            value.destinationOrigin,
            value.dataCategories,
            value.payloadHash,
            value.responseHash,
            value.outcome,
            value.finishedAt,
          ],
        )
        .then(() => undefined),
    );
  }
  async #with<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.databaseRole}`);
      await client.query('SET LOCAL search_path TO pg_catalog,metrics');
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
export function createPostgresProviderGovernanceStore(
  url: string,
  databaseRole:
    'rhea_provider_gateway' | 'rhea_provider_governance_admin' = 'rhea_provider_gateway',
) {
  const pool = new Pool({ connectionString: url });
  return { pool, store: new PostgresProviderGovernanceStore(pool, databaseRole) };
}
