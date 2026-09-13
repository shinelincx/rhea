import { createHmac } from 'node:crypto';

import type {
  LearningMetricEvent,
  MetricDefinition,
  MetricsGovernanceAuditRecord,
  MetricsGovernanceStore,
  ProviderQualityReadinessEvaluation,
  ReadinessEvidence,
} from '@rhea/metrics-governance';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface DefinitionDbRow extends QueryResultRow {
  denominator: string;
  exclusions: string[];
  key: string;
  numerator: string;
  owner: string;
  retention_days: number;
  version: string;
  window_days: number;
}

interface EventRow extends QueryResultRow {
  authority_state: LearningMetricEvent['authorityState'];
  event_key: string;
  event_type: string;
  family_token: string;
  occurred_at: Date;
  payload: LearningMetricEvent['payload'];
  profile_token: string;
  source: LearningMetricEvent['source'];
  version: string;
}

interface EvidenceRow extends QueryResultRow {
  key: ReadinessEvidence['key'];
  passed: boolean;
  reference: string;
  signed_by: string | null;
}

interface ProviderQualityRow extends QueryResultRow {
  evaluated_at: Date;
  id: string;
  passed: boolean;
  reasons: string[];
  release_snapshot: ProviderQualityReadinessEvaluation['releases'];
}

function mapProviderQuality(row: ProviderQualityRow): ProviderQualityReadinessEvaluation {
  return {
    evaluatedAt: row.evaluated_at.toISOString(),
    id: row.id,
    passed: row.passed,
    reasons: row.reasons,
    releases: row.release_snapshot,
  };
}

export class PostgresMetricsGovernanceStore implements MetricsGovernanceStore {
  constructor(
    readonly pool: Pool,
    readonly pepper: string,
    readonly databaseRole: 'rhea_metrics_app' | 'rhea_metrics_operator' = 'rhea_metrics_app',
  ) {
    if (pepper.length < 24)
      throw new Error('Metrics token pepper must contain at least 24 characters');
  }

  async evaluateProviderQualityReadiness(
    evaluationId: string,
    audit: MetricsGovernanceAuditRecord,
  ) {
    return this.#with(async (client) => {
      const result = await client.query<{ evaluation: ProviderQualityReadinessEvaluation }>(
        'SELECT metrics.operate_evaluate_provider_quality($1::uuid,$2,$3,$4) AS evaluation',
        [evaluationId, audit.actorId, audit.reason, audit.occurredAt],
      );
      const evaluation = result.rows[0]?.evaluation;
      if (!evaluation) throw new Error('供应商质量准入评估失败');
      return evaluation;
    });
  }

  async findLatestProviderQualityReadiness() {
    return this.#with(async (client) => {
      const result = await client.query<ProviderQualityRow>(
        `SELECT id,passed,reasons,release_snapshot,evaluated_at
         FROM metrics.provider_quality_readiness_evaluations
         ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
      );
      return result.rows[0] ? mapProviderQuality(result.rows[0]) : null;
    });
  }

  #token(value: string) {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  #purposeToken(purpose: 'event-key' | `source-aggregate:${string}`, value: string) {
    return createHmac('sha256', this.pepper).update(`${purpose}\0${value}`).digest('hex');
  }

  async getMetricDefinition(key: string, version: string) {
    return this.#with(async (client) => {
      const result = await client.query<DefinitionDbRow>(
        'SELECT key,version,numerator,denominator,exclusions,owner,window_days,retention_days FROM metrics.metric_registry WHERE key=$1 AND version=$2',
        [key, version],
      );
      const row = result.rows[0];
      return row
        ? {
            denominator: row.denominator,
            exclusions: row.exclusions,
            key: row.key,
            numerator: row.numerator,
            owner: row.owner,
            retentionDays: row.retention_days,
            version: row.version,
            windowDays: row.window_days,
          }
        : null;
    });
  }

  async registerMetric(value: MetricDefinition) {
    return this.#with(async (client) => {
      const result = await client.query<{ outcome: 'conflict' | 'recorded' | 'replayed' }>(
        'SELECT metrics.register_metric_definition($1::jsonb) AS outcome',
        [JSON.stringify(value)],
      );
      return result.rows[0]?.outcome ?? 'conflict';
    });
  }

  async registerMetricWithAudit(value: MetricDefinition, audit: MetricsGovernanceAuditRecord) {
    return this.#with(async (client) => {
      const result = await client.query<{ outcome: 'conflict' | 'recorded' | 'replayed' }>(
        'SELECT metrics.operate_register_metric($1::jsonb,$2,$3,$4) AS outcome',
        [JSON.stringify(value), audit.actorId, audit.reason, audit.occurredAt],
      );
      return result.rows[0]?.outcome ?? 'conflict';
    });
  }

  async recordMetricEvent(value: LearningMetricEvent) {
    return this.#with(async (client) => {
      const stored = {
        ...value,
        eventKey: this.#purposeToken('event-key', value.eventKey),
        familySpaceId: this.#token(value.familySpaceId),
        learningProfileId: this.#token(value.learningProfileId),
        source: {
          ...value.source,
          aggregateId: this.#purposeToken(
            `source-aggregate:${value.source.aggregateType}`,
            value.source.aggregateId,
          ),
        },
      };
      const result = await client.query<{
        outcome: 'conflict' | 'erased_subject' | 'recorded' | 'replayed';
      }>('SELECT metrics.record_learning_metric_event($1::jsonb) AS outcome', [
        JSON.stringify(stored),
      ]);
      return result.rows[0]?.outcome ?? 'conflict';
    });
  }

  async listMetricEvents() {
    return this.#with(async (client) => {
      const result = await client.query<EventRow>(
        'SELECT event_key,event_type,authority_state,family_token,profile_token,occurred_at,payload,source,version FROM metrics.learning_events ORDER BY occurred_at,event_key',
      );
      return result.rows.map((row) => ({
        authorityState: row.authority_state,
        eventKey: row.event_key,
        eventType: row.event_type,
        familySpaceId: row.family_token,
        learningProfileId: row.profile_token,
        occurredAt: row.occurred_at.toISOString(),
        payload: row.payload,
        source: row.source,
        version: row.version,
      }));
    });
  }

  async saveReadinessEvidence(value: ReadinessEvidence, audit: MetricsGovernanceAuditRecord) {
    await this.#with((client) =>
      client
        .query('SELECT metrics.operate_record_readiness_evidence($1::jsonb,$2,$3,$4)', [
          JSON.stringify(value),
          audit.actorId,
          audit.reason,
          audit.occurredAt,
        ])
        .then(() => undefined),
    );
  }

  async transitionMetricEventAuthority(input: {
    authorityState: 'disputed' | 'expired' | 'invalidated';
    eventKeys: string[];
  }) {
    return this.#with(async (client) => {
      const result = await client.query<{ updated: number }>(
        'SELECT metrics.transition_learning_metric_event_authority($1::jsonb) AS updated',
        [
          JSON.stringify({
            ...input,
            eventKeys: input.eventKeys.map((key) => this.#purposeToken('event-key', key)),
          }),
        ],
      );
      return result.rows[0]?.updated ?? 0;
    });
  }

  async listReadinessEvidence() {
    return this.#with(async (client) => {
      const result = await client.query<EvidenceRow>(
        'SELECT key,passed,reference,signed_by FROM metrics.readiness_evidence ORDER BY key',
      );
      return result.rows.map((row) => ({
        key: row.key,
        passed: row.passed,
        reference: row.reference,
        signedBy: row.signed_by,
      }));
    });
  }

  async purgeExpiredMetricData() {
    return this.#with(async (client) => {
      const result = await client.query<{ deleted: number }>(
        'SELECT metrics.purge_expired_metric_data() AS deleted',
      );
      return result.rows[0]?.deleted ?? 0;
    });
  }

  async #with<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.databaseRole}`);
      await client.query('SET LOCAL search_path TO pg_catalog, metrics');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresMetricsGovernanceStore(
  databaseUrl: string,
  pepper: string,
  databaseRole: 'rhea_metrics_app' | 'rhea_metrics_operator' = 'rhea_metrics_app',
) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresMetricsGovernanceStore(pool, pepper, databaseRole) };
}
