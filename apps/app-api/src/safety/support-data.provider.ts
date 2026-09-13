import type { SafetyEscalationService, SupportAccessScope } from '@rhea/safety-escalation';
import { Pool, type PoolClient } from 'pg';

export const SUPPORT_DATA_READER = Symbol('SUPPORT_DATA_READER');

export interface SupportDataDecision {
  allowed: boolean;
  expiresAt: string | null;
  familySpaceId: string | null;
  learningProfileId: string | null;
  reason: string;
  record: unknown;
}
export interface SupportDataReader {
  authorizeAndRead(input: {
    action: string;
    familySpaceId: string;
    grantId: string;
    recordId?: string;
    scope: SupportAccessScope;
    supportPrincipalId: string;
  }): Promise<SupportDataDecision>;
}

export function createServiceSupportDataReader(safety: SafetyEscalationService): SupportDataReader {
  return {
    async authorizeAndRead(input) {
      const decision = await safety.authorizeSupportOperation(input);
      return {
        allowed: decision.allowed,
        expiresAt: decision.grant?.expiresAt ?? null,
        familySpaceId: decision.grant?.familySpaceId ?? null,
        learningProfileId: decision.grant?.learningProfileId ?? null,
        reason: decision.reason,
        record: decision.allowed
          ? { recordId: input.recordId ?? null, scope: input.scope, status: 'local_unavailable' }
          : null,
      };
    },
  };
}

export function createPostgresSupportDataReader(databaseUrl: string): {
  pool: Pool;
  reader: SupportDataReader;
} {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    pool,
    reader: {
      async authorizeAndRead(input) {
        return withRole(pool, async (client) => {
          const result = await client.query<{ data: SupportDataDecision }>(
            'SELECT safety.authorize_and_read_support_data($1,$2,$3,$4,$5,$6) AS data',
            [
              input.grantId,
              input.supportPrincipalId,
              input.familySpaceId,
              input.scope,
              input.recordId ?? null,
              input.action,
            ],
          );
          const data = result.rows[0]?.data;
          if (!data || typeof data !== 'object') throw new Error('SUPPORT_DATA_DECISION_INVALID');
          return data;
        });
      },
    },
  };
}

async function withRole<Value>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Value>,
): Promise<Value> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_support_reader');
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
