import {
  GamificationService,
  LearningProgressError,
  type GamificationEventKind,
} from '@rhea/learning-progress';
import { MetricsGovernanceService } from '@rhea/metrics-governance';
import { PostgresGamificationStore } from '@rhea/postgres-learning-progress';
import { PostgresMetricsGovernanceStore } from '@rhea/postgres-metrics';
import { Pool, type PoolClient } from 'pg';

import type { OutboxEvent } from './outbox-relay.js';

interface SourceAuthorityReader {
  learningEvidenceEventKeys(input: {
    familySpaceId: string;
    learningProfileId: string;
    themeId: string;
  }): Promise<string[]>;
  learningEvidenceEventKeysForAssessment(input: {
    assessmentVersionId: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<string[]>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(value);
}

function metricPayload(payload: Record<string, unknown>) {
  const allowed = ['cycle', 'endedReason', 'hintLevel', 'outcome', 'qualification', 'reason'];
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = payload[key];
      return value === null || ['boolean', 'number', 'string'].includes(typeof value)
        ? [[key, value as boolean | number | string | null]]
        : [];
    }),
  );
}

function growthKind(event: OutboxEvent): GamificationEventKind | null {
  const payload = object(event.payload);
  if (event.event_type === 'learning_evidence.recorded') {
    if (payload.qualification === 'independent_success') return 'learning_evidence_independent';
    if (payload.qualification === 'assisted_success') return 'learning_evidence_assisted';
  }
  if (event.event_type === 'review_card.attempt_recorded') return 'review_completed';
  if (event.event_type === 'challenge.result_recorded' && payload.endedReason === 'completed') {
    return 'safe_challenge_completed';
  }
  return null;
}

type ProjectedAuthority =
  'accepted_current' | 'disputed' | 'expired' | 'invalidated' | 'pending' | 'shadow';

function projectedAuthority(
  event: OutboxEvent,
  payload: Record<string, unknown>,
): ProjectedAuthority {
  if (
    typeof payload.authorityState === 'string' &&
    ['accepted_current', 'disputed', 'expired', 'invalidated', 'pending', 'shadow'].includes(
      payload.authorityState,
    )
  ) {
    return payload.authorityState as ProjectedAuthority;
  }
  if (event.event_type === 'objective_assessment.disputed') return 'disputed';
  if (
    event.event_type.includes('unavailable') ||
    event.event_type.includes('canceled') ||
    event.event_type.includes('rejected') ||
    event.event_type.includes('ungradable')
  ) {
    return 'invalidated';
  }
  if (
    event.event_type.endsWith('.requested') ||
    (event.event_type === 'suggested_assessment.created' && payload.status === 'queued')
  ) {
    return 'pending';
  }
  return 'accepted_current';
}

const METRIC_AGGREGATES = new Set([
  'challenge_result',
  'generated_learning',
  'learning_evidence',
  'objective_assessment',
  'review_card',
  'suggested_assessment',
  'wrong_item',
  'wrong_item_theme',
]);

export class DomainEventProjector {
  constructor(
    readonly gamification: GamificationService,
    readonly metrics: MetricsGovernanceService,
    readonly sourceAuthority: SourceAuthorityReader,
  ) {}

  async project(event: OutboxEvent): Promise<void> {
    const payload = object(event.payload);
    if (METRIC_AGGREGATES.has(event.aggregate_type)) {
      await this.metrics.recordLearningEvent({
        authorityState: projectedAuthority(event, payload),
        eventKey: event.id,
        eventType: event.event_type,
        familySpaceId: event.family_space_id,
        learningProfileId: event.learning_profile_id,
        occurredAt: event.occurred_at.toISOString(),
        payload: metricPayload(payload),
        source: {
          aggregateId: event.aggregate_id,
          aggregateType: event.aggregate_type,
          version: 'domain-outbox-v1',
        },
        version: 'learning-metric-event-v1',
      });
    }

    const kind = growthKind(event);
    if (kind) {
      await this.gamification.recordEvent({
        authorityState: projectedAuthority(event, payload),
        eventKey: event.id,
        expiresAt: null,
        familySpaceId: event.family_space_id,
        kind,
        learningDate: shanghaiDate(event.occurred_at),
        learningProfileId: event.learning_profile_id,
        occurredAt: event.occurred_at.toISOString(),
        sourceReferenceId: event.aggregate_id,
        sourceVersion: 'domain-outbox-v1',
      });
    }

    if (
      event.event_type === 'objective_assessment.disputed' &&
      typeof payload.assessmentVersionId === 'string'
    ) {
      const evidenceKeys = await this.sourceAuthority.learningEvidenceEventKeysForAssessment({
        assessmentVersionId: payload.assessmentVersionId,
        familySpaceId: event.family_space_id,
        learningProfileId: event.learning_profile_id,
      });
      for (const eventKey of evidenceKeys) {
        try {
          await this.gamification.updateEventAuthority({
            authorityState: 'disputed',
            eventKey,
            familySpaceId: event.family_space_id,
            learningProfileId: event.learning_profile_id,
            sourceVersion: 'assessment-disputed-v1',
          });
        } catch (error) {
          if (!(
            error instanceof LearningProgressError && error.code === 'GROWTH_EVENT_NOT_FOUND'
          )) {
            throw error;
          }
        }
      }
      await this.metrics.transitionLearningEventsAuthority({
        authorityState: 'disputed',
        eventKeys: [payload.assessmentVersionId, ...evidenceKeys],
      });
    }

    if (
      event.event_type === 'wrong_item_theme.reopened' &&
      payload.reason === 'source_invalidated' &&
      typeof payload.themeId === 'string'
    ) {
      const eventKeys = await this.sourceAuthority.learningEvidenceEventKeys({
        familySpaceId: event.family_space_id,
        learningProfileId: event.learning_profile_id,
        themeId: payload.themeId,
      });
      for (const eventKey of eventKeys) {
        try {
          await this.gamification.updateEventAuthority({
            authorityState: 'invalidated',
            eventKey,
            familySpaceId: event.family_space_id,
            learningProfileId: event.learning_profile_id,
            sourceVersion: 'source-invalidated-v1',
          });
        } catch (error) {
          if (!(
            error instanceof LearningProgressError && error.code === 'GROWTH_EVENT_NOT_FOUND'
          )) {
            throw error;
          }
        }
      }
      await this.metrics.transitionLearningEventsAuthority({
        authorityState: 'invalidated',
        eventKeys,
      });
    }
  }
}

class PostgresSourceAuthorityReader implements SourceAuthorityReader {
  constructor(readonly pool: Pool) {}

  async learningEvidenceEventKeys(input: {
    familySpaceId: string;
    learningProfileId: string;
    themeId: string;
  }) {
    return this.#withScope(input, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id::text
         FROM learning.learning_evidence
         WHERE family_space_id=$1 AND learning_profile_id=$2 AND theme_id=$3`,
        [input.familySpaceId, input.learningProfileId, input.themeId],
      );
      return result.rows.map(({ id }) => id);
    });
  }

  async learningEvidenceEventKeysForAssessment(input: {
    assessmentVersionId: string;
    familySpaceId: string;
    learningProfileId: string;
  }) {
    return this.#withScope(input, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id::text
         FROM learning.learning_evidence
         WHERE family_space_id=$1 AND learning_profile_id=$2
           AND source_versions @> jsonb_build_object('assessmentVersionId',$3::text)`,
        [input.familySpaceId, input.learningProfileId, input.assessmentVersionId],
      );
      return result.rows.map(({ id }) => id);
    });
  }

  async #withScope<Value>(
    scope: { familySpaceId: string; learningProfileId: string },
    operation: (client: PoolClient) => Promise<Value>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_learning_progress_app');
      await client.query(`SELECT set_config('rhea.family_space_id',$1,true)`, [
        scope.familySpaceId,
      ]);
      await client.query(`SELECT set_config('rhea.learning_profile_id',$1,true)`, [
        scope.learningProfileId,
      ]);
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

export function createPostgresDomainEventProjector(databaseUrl: string, metricsPepper: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const metricsStore = new PostgresMetricsGovernanceStore(pool, metricsPepper);
  return {
    pool,
    purgeExpiredMetrics: () => metricsStore.purgeExpiredMetricData(),
    projector: new DomainEventProjector(
      new GamificationService({ store: new PostgresGamificationStore(pool) }),
      new MetricsGovernanceService(metricsStore),
      new PostgresSourceAuthorityReader(pool),
    ),
  };
}
