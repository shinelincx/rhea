import { isDeepStrictEqual } from 'node:util';

import {
  buildQualityCard,
  type AuthorizationDecision,
  type AuthorizationDecisionGuard,
  type AuthorizationDecisionSaveResult,
  type AuthorizationRevalidation,
  type AuthorizationRevalidationSnapshot,
  type CapabilityKind,
  type CapabilityMutation,
  type CapabilityRecord,
  type ContainmentOrder,
  type ContainmentSaveGuard,
  type ContainmentState,
  type QualityCommandReceipt,
  type QualityControlStore,
  type RequiredSlicePolicy,
  type RevalidateAuthorizationInput,
  type ShadowObservation,
} from '@rhea/quality-control';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

type DatabaseRole = 'rhea_quality_governance' | 'rhea_quality_runtime';

function decode<Value>(value: unknown): Value {
  const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as Value;
  return normalizeTimestamps(parsed);
}

const timestampKeys = new Set([
  'changedAt',
  'completedAt',
  'containedAt',
  'issuedAt',
  'observedAt',
  'registeredAt',
  'signedAt',
  'updatedAt',
]);

function normalizeTimestamps<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTimestamps(entry)) as Value;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      timestampKeys.has(key) && typeof entry === 'string'
        ? new Date(entry).toISOString()
        : normalizeTimestamps(entry),
    ]),
  ) as Value;
}

function firstValue<Value>(rows: QueryResultRow[], key: string): Value | null {
  const value = rows[0]?.[key];
  return value === null || value === undefined ? null : decode<Value>(value);
}

function assertCapabilityMutation(
  current: CapabilityRecord,
  next: CapabilityRecord,
  expectedRevision: number,
  mutation: CapabilityMutation,
): void {
  const commonIsValid =
    current.revision === expectedRevision &&
    next.revision === expectedRevision + 1 &&
    isDeepStrictEqual(current.version, next.version);
  const evaluationChanged =
    next.evaluationRuns.length === current.evaluationRuns.length + 1 &&
    isDeepStrictEqual(next.evaluationRuns.slice(0, -1), current.evaluationRuns);
  const signoffChanged =
    next.signoffs.length === current.signoffs.length + 1 &&
    isDeepStrictEqual(next.signoffs.slice(0, -1), current.signoffs);
  const rolloutChanged = !isDeepStrictEqual(current.rollout, next.rollout);
  const matches =
    commonIsValid &&
    ((mutation === 'evaluation' &&
      evaluationChanged &&
      !signoffChanged &&
      isDeepStrictEqual(current.signoffs, next.signoffs) &&
      !rolloutChanged) ||
      (mutation === 'signoff' &&
        signoffChanged &&
        !evaluationChanged &&
        isDeepStrictEqual(current.evaluationRuns, next.evaluationRuns) &&
        !rolloutChanged) ||
      (mutation === 'rollout' &&
        rolloutChanged &&
        !evaluationChanged &&
        !signoffChanged &&
        isDeepStrictEqual(current.evaluationRuns, next.evaluationRuns) &&
        isDeepStrictEqual(current.signoffs, next.signoffs)));
  if (!matches) {
    throw new Error(`Capability mutation does not match '${mutation}' discriminator`);
  }
}

export class PostgresQualityControlStore implements QualityControlStore {
  constructor(private readonly pool: Pool) {}

  async createCapability(
    record: CapabilityRecord,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'> {
    return this.#withRole('rhea_quality_governance', async (client) => {
      const query = await client.query<{ status: 'conflict' | 'created' | 'duplicate' }>(
        `SELECT metrics.create_quality_capability($1::jsonb, $2, $3) AS status`,
        [record, receipt.commandId, receipt.fingerprint],
      );
      return query.rows[0]?.status ?? 'conflict';
    });
  }

  async createSlicePolicy(
    policy: RequiredSlicePolicy,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'> {
    return this.#withRole('rhea_quality_governance', async (client) => {
      const query = await client.query<{ status: 'conflict' | 'created' | 'duplicate' }>(
        `SELECT metrics.create_quality_slice_policy($1::jsonb, $2, $3) AS status`,
        [policy, receipt.commandId, receipt.fingerprint],
      );
      return query.rows[0]?.status ?? 'conflict';
    });
  }

  async createShadowObservation(
    observation: ShadowObservation,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query<{ status: 'conflict' | 'created' | 'duplicate' }>(
        `SELECT metrics.create_quality_shadow_observation($1::jsonb, $2, $3) AS status`,
        [observation, receipt.commandId, receipt.fingerprint],
      );
      return query.rows[0]?.status ?? 'conflict';
    });
  }

  async findCapability(id: string): Promise<CapabilityRecord | null> {
    return this.#withRole('rhea_quality_runtime', (client) => this.#readCapability(client, id));
  }

  async findAuthorizationDecision(id: string): Promise<AuthorizationDecision | null> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query(
        `SELECT metrics.read_capability_authorization($1) AS value`,
        [id],
      );
      return firstValue<AuthorizationDecision>(query.rows, 'value');
    });
  }

  async findCommand(commandId: string): Promise<QualityCommandReceipt | null> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query(`SELECT metrics.read_quality_command($1) AS value`, [
        commandId,
      ]);
      return firstValue<QualityCommandReceipt>(query.rows, 'value');
    });
  }

  async findContainmentState(): Promise<ContainmentState> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query(`SELECT metrics.read_quality_containment_state() AS state`);
      return firstValue<ContainmentState>(query.rows, 'state') ?? { epoch: 0, orders: [] };
    });
  }

  async findSlicePolicy(version: string): Promise<RequiredSlicePolicy | null> {
    return this.#withRole('rhea_quality_runtime', (client) => this.#readPolicy(client, version));
  }

  async findShadowObservation(id: string): Promise<ShadowObservation | null> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query(
        `SELECT metrics.read_quality_shadow_observation($1) AS value`,
        [id],
      );
      return firstValue<ShadowObservation>(query.rows, 'value');
    });
  }

  async listCapabilities(capabilityKey: string, kind: CapabilityKind): Promise<CapabilityRecord[]> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query<{ value: unknown }>(
        `SELECT value FROM metrics.list_quality_capabilities($1, $2) AS value`,
        [capabilityKey, kind],
      );
      return query.rows.map(({ value }) => decode<CapabilityRecord>(value));
    });
  }

  async saveAuthorizationDecision(
    decision: AuthorizationDecision,
    guard: AuthorizationDecisionGuard,
  ): Promise<AuthorizationDecisionSaveResult> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const query = await client.query<{ value: unknown }>(
        `SELECT metrics.save_quality_authorization_decision($1::jsonb, $2::jsonb) AS value`,
        [decision, guard],
      );
      return (
        firstValue<AuthorizationDecisionSaveResult>(query.rows, 'value') ?? {
          status: 'conflict',
        }
      );
    });
  }

  async saveContainmentOrder(
    order: ContainmentOrder,
    guard: ContainmentSaveGuard,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'duplicate' | 'saved'> {
    return this.#withRole('rhea_quality_governance', async (client) => {
      const query = await client.query<{ status: 'conflict' | 'duplicate' | 'saved' }>(
        `SELECT metrics.contain_capability($1::jsonb, $2::jsonb, $3, $4) AS status`,
        [order, guard, receipt.commandId, receipt.fingerprint],
      );
      return query.rows[0]?.status ?? 'conflict';
    });
  }

  async revalidateAuthorizationAtomically(
    input: RevalidateAuthorizationInput,
    inspect: (snapshot: AuthorizationRevalidationSnapshot) => AuthorizationRevalidation,
  ): Promise<AuthorizationRevalidation> {
    return this.#withRole('rhea_quality_runtime', async (client) => {
      const snapshotQuery = await client.query<{ value: unknown }>(
        `SELECT metrics.lock_authorization_revalidation_snapshot($1) AS value`,
        [input.decisionId],
      );
      const snapshot = firstValue<AuthorizationRevalidationSnapshot>(snapshotQuery.rows, 'value');
      if (!snapshot) throw new Error('Quality authorization snapshot was not returned');
      const inspected = inspect(snapshot);
      const checkedAt = new Date().toISOString();
      const databaseQuery = await client.query<{ value: unknown }>(
        `SELECT metrics.revalidate_capability_authorization($1, $2, $3, $4, $5) AS value`,
        [input.decisionId, input.expectedContainmentEpoch, input.phase, input.route, checkedAt],
      );
      const authoritative = firstValue<AuthorizationRevalidation>(databaseQuery.rows, 'value');
      if (!authoritative || !isDeepStrictEqual(authoritative, inspected)) {
        throw new Error(
          `Domain and PostgreSQL authorization revalidation disagree: ${JSON.stringify({ authoritative, inspected })}`,
        );
      }
      return authoritative;
    });
  }

  async saveCapability(
    record: CapabilityRecord,
    expectedRevision: number,
    receipt: QualityCommandReceipt,
    mutation: CapabilityMutation,
  ): Promise<'conflict' | 'duplicate' | 'saved'> {
    return this.#withRole('rhea_quality_governance', async (client) => {
      const current = await this.#readCapability(client, record.version.id);
      if (!current) return 'conflict';
      assertCapabilityMutation(current, record, expectedRevision, mutation);
      if (mutation === 'evaluation') {
        const policy = await this.#readPolicy(client, record.version.requiredSlicePolicyVersion);
        if (!policy) return 'conflict';
        const run = record.evaluationRuns.at(-1);
        if (!run) throw new Error('Evaluation mutation is missing its appended run');
        const card = buildQualityCard(record, policy);
        const query = await client.query<{ status: 'conflict' | 'duplicate' | 'saved' }>(
          `SELECT metrics.append_quality_evaluation(
             $1::jsonb, $2::jsonb, $3, $4, $5
           ) AS status`,
          [run, card, expectedRevision, receipt.commandId, receipt.fingerprint],
        );
        return query.rows[0]?.status ?? 'conflict';
      }
      if (mutation === 'signoff') {
        const signoff = record.signoffs.at(-1);
        if (!signoff) throw new Error('Signoff mutation is missing its appended signoff');
        const query = await client.query<{ status: 'conflict' | 'duplicate' | 'saved' }>(
          `SELECT metrics.append_quality_signoff(
             $1, $2::jsonb, $3, $4, $5, $6, $7
           ) AS status`,
          [
            record.version.id,
            signoff,
            expectedRevision,
            receipt.commandId,
            receipt.fingerprint,
            signoff.signer.id,
            signoff.signer.role,
          ],
        );
        return query.rows[0]?.status ?? 'conflict';
      }
      const query = await client.query<{ status: 'conflict' | 'duplicate' | 'saved' }>(
        `SELECT metrics.advance_quality_rollout($1, $2::jsonb, $3, $4, $5, $6) AS status`,
        [
          record.version.id,
          record.rollout,
          expectedRevision,
          receipt.commandId,
          receipt.fingerprint,
          'quality-governance',
        ],
      );
      return query.rows[0]?.status ?? 'conflict';
    });
  }

  async #readCapability(client: PoolClient, id: string): Promise<CapabilityRecord | null> {
    const query = await client.query(`SELECT metrics.read_quality_capability($1) AS record`, [id]);
    return firstValue<CapabilityRecord>(query.rows, 'record');
  }

  async #readPolicy(client: PoolClient, version: string): Promise<RequiredSlicePolicy | null> {
    const query = await client.query(`SELECT metrics.read_quality_slice_policy($1) AS policy`, [
      version,
    ]);
    return firstValue<RequiredSlicePolicy>(query.rows, 'policy');
  }

  async #withRole<Value>(role: DatabaseRole, operation: (client: PoolClient) => Promise<Value>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
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
