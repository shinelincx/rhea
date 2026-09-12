import { randomUUID } from 'node:crypto';

import type {
  ReviewCardAttempt,
  ReviewCardPublicationGate,
  ReviewCardStore,
  ShortReviewSession,
  StoredReviewCard,
  StoredReviewCardRequest,
} from '@rhea/learning-progress';
import {
  publishArtifactInTransaction,
  syncSourceRevisionInTransaction,
} from '@rhea/postgres-source-lineage';
import { sourceLineageFingerprint, type SourceDependency } from '@rhea/source-lineage';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  findThemeMasteryInTransaction,
  recordEvidenceInTransaction,
  reopenThemeForInvalidSourceInTransaction,
} from './theme-mastery.js';

interface RequestRow extends QueryResultRow {
  actor: unknown;
  authorization_snapshot: unknown;
  capability: unknown | null;
  created_at: Date;
  current_card_id: string | null;
  family_space_id: string;
  id: string;
  idempotency_key: string;
  latest_checks: unknown;
  learning_profile_id: string;
  model_runs: unknown;
  processing_lease_expires_at: Date | null;
  rebuild_pending: boolean;
  request_fingerprint: string;
  source_snapshot: unknown;
  state_revision: number;
  status: StoredReviewCardRequest['status'];
  unavailable_reason: StoredReviewCardRequest['unavailableReason'];
  updated_at: Date;
}

interface CardRow extends QueryResultRow {
  candidate: unknown;
  capability_version_id: string;
  checks: unknown;
  created_at: Date;
  family_space_id: string;
  id: string;
  learning_profile_id: string;
  request_id: string;
  schedule: unknown;
  source_snapshot: unknown;
  status: StoredReviewCard['status'];
  version: number;
}

interface SessionRow extends QueryResultRow {
  card_ids: string[];
  created_at: Date;
  id: string;
  learning_profile_id: string;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

export class PostgresReviewCardStore implements ReviewCardStore, ReviewCardPublicationGate {
  constructor(readonly pool: Pool) {}

  async authorize(input: Parameters<ReviewCardPublicationGate['authorize']>[0]): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      await this.#setFamily(client, input.familySpaceId);
      const result = await client.query<{ authorized: boolean }>(
        `SELECT learning.authorize_generated_learning($1, $2, $3, $4) AS authorized`,
        [input.learningProfileId, input.familySpaceId, input.consentRevision, input.ageBand],
      );
      return result.rows[0]?.authorized === true;
    });
  }

  async createReviewCardRequest(request: StoredReviewCardRequest): Promise<boolean> {
    return this.#withProfile(request.learningProfileId, async (client) => {
      await this.#setFamily(client, request.familySpaceId);
      const result = await client.query<{ created: boolean }>(
        `SELECT learning.create_review_card_request($1::jsonb) AS created`,
        [JSON.stringify({ ...request, eventId: randomUUID() })],
      );
      return result.rows[0]?.created === true;
    });
  }

  async findReviewCardRequestByIdempotencyKey(
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<StoredReviewCardRequest | null> {
    return this.#findRequest(learningProfileId, 'idempotency_key = $2', idempotencyKey);
  }

  async findReviewCardRequestById(
    id: string,
    learningProfileId: string,
  ): Promise<StoredReviewCardRequest | null> {
    return this.#findRequest(learningProfileId, 'id = $2', id);
  }

  async markReviewCardGenerating(
    input: Parameters<ReviewCardStore['markReviewCardGenerating']>[0],
  ): Promise<boolean> {
    return this.#booleanMutation(
      input.learningProfileId,
      'claim_review_card_request',
      'claimed',
      input,
    );
  }

  async completeReviewCardRequest(
    input: Parameters<ReviewCardStore['completeReviewCardRequest']>[0],
  ): Promise<
    | 'capability_contained'
    | 'capability_unavailable'
    | 'completed'
    | 'conflict'
    | 'consent_withdrawn'
    | 'source_changed'
  > {
    return this.#withProfile(input.card.learningProfileId, async (client) => {
      await this.#setFamily(client, input.card.familySpaceId);
      const result = await client.query<{ outcome: string }>(
        `SELECT learning.complete_review_card_request($1::jsonb) AS outcome`,
        [JSON.stringify({ ...input, eventId: randomUUID() })],
      );
      const outcome = result.rows[0]?.outcome;
      if (
        ![
          'capability_contained',
          'capability_unavailable',
          'completed',
          'conflict',
          'consent_withdrawn',
          'source_changed',
        ].includes(outcome ?? '')
      ) {
        throw new Error('Unexpected review-card completion outcome');
      }
      if (outcome === 'completed') await this.#publishLineage(client, input.card);
      return outcome as
        | 'capability_contained'
        | 'capability_unavailable'
        | 'completed'
        | 'conflict'
        | 'consent_withdrawn'
        | 'source_changed';
    });
  }

  async failReviewCardRequest(
    input: Parameters<ReviewCardStore['failReviewCardRequest']>[0],
  ): Promise<boolean> {
    return this.#booleanMutation(input.learningProfileId, 'fail_review_card_request', 'failed', {
      ...input,
      eventId: randomUUID(),
    });
  }

  async invalidateReviewCard(
    input: Parameters<ReviewCardStore['invalidateReviewCard']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const request = await client.query<{
        family_space_id: string;
        source_snapshot: unknown;
      }>(
        `SELECT family_space_id, source_snapshot
         FROM learning.review_card_requests
         WHERE learning_profile_id = $1 AND id = $2`,
        [input.learningProfileId, input.requestId],
      );
      const row = request.rows[0];
      if (!row) return false;
      await this.#setFamily(client, row.family_space_id);
      const result = await client.query<{ invalidated: boolean }>(
        `SELECT learning.invalidate_review_card($1::jsonb) AS invalidated`,
        [JSON.stringify({ ...input, eventId: randomUUID() })],
      );
      if (result.rows[0]?.invalidated !== true) return false;
      if (input.reason === 'SOURCE_CHANGED') {
        const source = json<StoredReviewCard['source']>(row.source_snapshot);
        if (
          !(await reopenThemeForInvalidSourceInTransaction(client, {
            learningProfileId: input.learningProfileId,
            occurredAt: input.updatedAt,
            themeId: source.themeId,
            triggerKey: `review-card-request:${input.requestId}:source-invalidated`,
          }))
        ) {
          throw new Error('Invalid review-card source did not reopen its theme');
        }
      }
      return true;
    });
  }

  async findReviewCardById(
    id: string,
    learningProfileId: string,
  ): Promise<StoredReviewCard | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<CardRow>(
        `${this.#cardSelect()} WHERE learning_profile_id = $1 AND id = $2`,
        [learningProfileId, id],
      );
      return result.rows[0] ? this.#card(result.rows[0]) : null;
    });
  }

  async listActiveReviewCards(learningProfileId: string): Promise<StoredReviewCard[]> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<CardRow>(
        `${this.#cardSelect()}
         WHERE learning_profile_id = $1 AND status = 'active'
         ORDER BY (schedule ->> 'pendingCorrection')::boolean DESC,
                  (schedule ->> 'dueAt')::timestamptz, id`,
        [learningProfileId],
      );
      return result.rows.map((row) => this.#card(row));
    });
  }

  async createShortReviewSession(session: ShortReviewSession): Promise<boolean> {
    return this.#booleanMutation(
      session.learningProfileId,
      'create_short_review_session',
      'created',
      session,
    );
  }

  async findShortReviewSession(
    id: string,
    learningProfileId: string,
  ): Promise<ShortReviewSession | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<SessionRow>(
        `SELECT id, learning_profile_id, card_ids, created_at
         FROM learning.short_review_sessions
         WHERE learning_profile_id = $1 AND id = $2`,
        [learningProfileId, id],
      );
      const row = result.rows[0];
      return row
        ? {
            cardIds: row.card_ids,
            createdAt: timestamp(row.created_at),
            id: row.id,
            learningProfileId: row.learning_profile_id,
          }
        : null;
    });
  }

  async findReviewAttemptByIdempotencyKey(
    cardId: string,
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<ReviewCardAttempt | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<{ attempt: unknown }>(
        `SELECT attempt FROM learning.review_card_attempts
         WHERE learning_profile_id = $1 AND card_id = $2 AND idempotency_key = $3`,
        [learningProfileId, cardId, idempotencyKey],
      );
      return result.rows[0] ? json(result.rows[0].attempt) : null;
    });
  }

  async findWrongItemThemeMastery(themeId: string, learningProfileId: string) {
    return this.#withProfile(learningProfileId, (client) =>
      findThemeMasteryInTransaction(client, themeId, learningProfileId),
    );
  }

  async recordReviewAttempt(
    input: Parameters<ReviewCardStore['recordReviewAttempt']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const card = await client.query<{ family_space_id: string }>(
        `SELECT family_space_id FROM learning.review_cards
         WHERE learning_profile_id = $1 AND id = $2`,
        [input.learningProfileId, input.attempt.cardId],
      );
      if (!card.rows[0]) return false;
      await this.#setFamily(client, card.rows[0].family_space_id);
      const result = await client.query<{ recorded: boolean }>(
        `SELECT learning.record_review_card_attempt($1::jsonb) AS recorded`,
        [JSON.stringify({ ...input, eventId: randomUUID() })],
      );
      if (result.rows[0]?.recorded !== true) return false;
      if (!(await recordEvidenceInTransaction(client, input.evidence))) {
        throw new Error('Review-attempt learning evidence was rejected');
      }
      return true;
    });
  }

  async #findRequest(
    learningProfileId: string,
    predicate: string,
    value: string,
  ): Promise<StoredReviewCardRequest | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<RequestRow>(
        `${this.#requestSelect()} WHERE learning_profile_id = $1 AND ${predicate}`,
        [learningProfileId, value],
      );
      return result.rows[0] ? this.#request(result.rows[0]) : null;
    });
  }

  async #booleanMutation(
    learningProfileId: string,
    functionName: string,
    alias: string,
    payload: unknown,
  ): Promise<boolean> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<Record<string, boolean>>(
        `SELECT learning.${functionName}($1::jsonb) AS ${alias}`,
        [JSON.stringify(payload)],
      );
      return result.rows[0]?.[alias] === true;
    });
  }

  #request(row: RequestRow): StoredReviewCardRequest {
    return {
      actor: json(row.actor),
      authorization: json(row.authorization_snapshot),
      capability: row.capability ? json(row.capability) : null,
      createdAt: timestamp(row.created_at),
      currentCardId: row.current_card_id,
      familySpaceId: row.family_space_id,
      id: row.id,
      idempotencyKey: row.idempotency_key,
      latestChecks: json(row.latest_checks),
      learningProfileId: row.learning_profile_id,
      modelRuns: json(row.model_runs),
      processingLeaseExpiresAt: row.processing_lease_expires_at
        ? timestamp(row.processing_lease_expires_at)
        : null,
      rebuildPending: row.rebuild_pending,
      requestFingerprint: row.request_fingerprint,
      source: json(row.source_snapshot),
      stateRevision: row.state_revision,
      status: row.status,
      unavailableReason: row.unavailable_reason,
      updatedAt: timestamp(row.updated_at),
    };
  }

  #card(row: CardRow): StoredReviewCard {
    return {
      candidate: json(row.candidate),
      capabilityVersionId: row.capability_version_id,
      checks: json(row.checks),
      createdAt: timestamp(row.created_at),
      familySpaceId: row.family_space_id,
      id: row.id,
      learningProfileId: row.learning_profile_id,
      requestId: row.request_id,
      schedule: json(row.schedule),
      source: json(row.source_snapshot),
      status: row.status,
      version: row.version,
    };
  }

  #requestSelect(): string {
    return `SELECT id, family_space_id, learning_profile_id, idempotency_key,
                   actor, authorization_snapshot, capability, source_snapshot, request_fingerprint,
                   status, unavailable_reason, current_card_id, latest_checks, model_runs,
                   processing_lease_expires_at, rebuild_pending, state_revision,
                   created_at, updated_at
            FROM learning.review_card_requests`;
  }

  #cardSelect(): string {
    return `SELECT id, request_id, family_space_id, learning_profile_id,
                   capability_version_id, version, candidate, checks,
                   source_snapshot, schedule, status, created_at
            FROM learning.review_cards`;
  }

  async #publishLineage(client: PoolClient, card: StoredReviewCard): Promise<void> {
    const scope = {
      familySpaceId: card.familySpaceId,
      learningProfileId: card.learningProfileId,
    };
    const dependencies: SourceDependency[] = [];
    const sync = async (
      id: string,
      kind: SourceDependency['source']['kind'],
      version: string,
      usage: string,
    ) => {
      const source = await syncSourceRevisionInTransaction(client, {
        occurredAt: card.createdAt,
        reason: `review card ${usage} snapshot`,
        source: { ...scope, id, kind },
        version,
      });
      dependencies.push({ source, usage });
    };
    await sync(
      card.source.wrongItemId,
      'derived_artifact',
      `state:${card.source.wrongItemStateRevision}`,
      'wrong_item',
    );
    await sync(
      card.source.wrongItemId,
      'classification',
      `classification:${card.source.classificationRevision}`,
      'wrong_item_classification',
    );
    await sync(card.capabilityVersionId, 'capability', card.capabilityVersionId, 'ai_capability');
    const publication = {
      artifact: {
        ...scope,
        id: card.id,
        kind: 'review_card' as const,
        rebuildable: true,
        version: `version:${card.version}`,
      },
      commandId: `lineage:review-card:${card.id}:version:${card.version}`,
      dependencies,
      expectedPreviousVersion: null,
      occurredAt: card.createdAt,
    };
    const saved = await publishArtifactInTransaction(client, publication, {
      commandId: publication.commandId,
      fingerprint: sourceLineageFingerprint(publication),
    });
    if (saved.status === 'conflict' || saved.status === 'idempotency_conflict') {
      throw new Error('Review card lineage publication conflicted');
    }
  }

  async #setFamily(client: PoolClient, familySpaceId: string): Promise<void> {
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
  }

  async #withProfile<Value>(
    learningProfileId: string,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_learning_progress_app');
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        learningProfileId,
      ]);
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
