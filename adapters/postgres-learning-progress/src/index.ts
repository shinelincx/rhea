import { randomUUID } from 'node:crypto';

import type {
  ImmediateCorrectionAttempt,
  LearningProgressStore,
  MistakeReasonRevision,
  StoredWrongItem,
} from '@rhea/learning-progress';
import {
  publishArtifactInTransaction,
  syncSourceRevisionInTransaction,
} from '@rhea/postgres-source-lineage';
import { sourceLineageFingerprint, type SourceDependency } from '@rhea/source-lineage';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface WrongItemRow extends QueryResultRow {
  assessment_snapshot: unknown;
  classification: unknown;
  created_at: Date;
  deduplication_key: string;
  family_space_id: string;
  first_incorrect_at: Date;
  id: string;
  learning_profile_id: string;
  material_id: string;
  reason_candidate: unknown;
  state_revision: number;
  status: StoredWrongItem['status'];
  theme_id: string;
  updated_at: Date;
}

interface ReasonRow extends QueryResultRow {
  action: MistakeReasonRevision['action'];
  actor_id: string;
  actor_type: MistakeReasonRevision['actor']['type'];
  category: MistakeReasonRevision['category'];
  changed_at: Date;
  explanation: string | null;
  id: string;
  reason: string | null;
  revision: number;
}

interface CorrectionRow extends QueryResultRow {
  assessment_version_id: string;
  basis: unknown;
  created_at: Date;
  id: string;
  idempotency_key: string;
  normalized_response: string | null;
  outcome: ImmediateCorrectionAttempt['outcome'];
  response_text: string;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

function basisLineageVersion(item: StoredWrongItem): string {
  const basis = item.assessment.basis;
  return `${basis.sourceVersionId}:${basis.selectionVersion}:${basis.validityEpoch}`;
}

export class PostgresLearningProgressStore implements LearningProgressStore {
  constructor(readonly pool: Pool) {}

  async createWrongItem(item: StoredWrongItem): Promise<boolean> {
    return this.#withProfile(item.learningProfileId, async (client) => {
      await this.#setFamily(client, item.familySpaceId);
      const result = await client.query<{ created: boolean }>(
        `SELECT learning.create_wrong_item($1::jsonb) AS created`,
        [JSON.stringify({ ...item, eventId: randomUUID() })],
      );
      if (result.rows[0]?.created !== true) return false;
      await this.#publishLineage(client, item, null, item.createdAt);
      return true;
    });
  }

  async findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredWrongItem | null> {
    return this.#findOne(learningProfileId, 'deduplication_key = $2', deduplicationKey);
  }

  async findById(id: string, learningProfileId: string): Promise<StoredWrongItem | null> {
    return this.#findOne(learningProfileId, 'id = $2', id);
  }

  async listWrongItems(learningProfileId: string): Promise<StoredWrongItem[]> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<WrongItemRow>(
        `${this.#select()} WHERE learning_profile_id = $1 ORDER BY first_incorrect_at, id`,
        [learningProfileId],
      );
      const items: StoredWrongItem[] = [];
      for (const row of result.rows) items.push(await this.#hydrate(client, row));
      return items;
    });
  }

  async recordAccess(input: Parameters<LearningProgressStore['recordAccess']>[0]): Promise<void> {
    await this.#withProfile(input.learningProfileId, async (client) => {
      await client.query(
        `INSERT INTO learning.wrong_item_access_audit
          (family_space_id, learning_profile_id, wrong_item_id,
           actor_type, actor_id, action)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.familySpaceId,
          input.learningProfileId,
          input.wrongItemId,
          input.actor.type,
          input.actor.id,
          input.action,
        ],
      );
    });
  }

  async recordCorrection(
    input: Parameters<LearningProgressStore['recordCorrection']>[0],
  ): Promise<boolean> {
    return this.#mutate(input.learningProfileId, input.wrongItemId, async (client, item) => {
      const result = await client.query<{ recorded: boolean }>(
        `SELECT learning.record_immediate_correction($1::jsonb) AS recorded`,
        [JSON.stringify(input)],
      );
      if (result.rows[0]?.recorded !== true) return false;
      await this.#publishLineage(
        client,
        { ...item, stateRevision: input.expectedStateRevision + 1 },
        `state:${input.expectedStateRevision}`,
        input.updatedAt,
      );
      return true;
    });
  }

  async reviseClassification(
    input: Parameters<LearningProgressStore['reviseClassification']>[0],
  ): Promise<boolean> {
    return this.#mutate(input.learningProfileId, input.wrongItemId, async (client, item) => {
      const result = await client.query<{ revised: boolean }>(
        `SELECT learning.revise_wrong_item_classification($1::jsonb) AS revised`,
        [JSON.stringify({ ...input, eventId: randomUUID() })],
      );
      if (result.rows[0]?.revised !== true) return false;
      await this.#publishLineage(
        client,
        { ...item, stateRevision: input.expectedStateRevision + 1 },
        `state:${input.expectedStateRevision}`,
        input.updatedAt,
      );
      return true;
    });
  }

  async reviseReason(
    input: Parameters<LearningProgressStore['reviseReason']>[0],
  ): Promise<boolean> {
    return this.#mutate(input.learningProfileId, input.wrongItemId, async (client, item) => {
      const result = await client.query<{ revised: boolean }>(
        `SELECT learning.revise_wrong_item_reason($1::jsonb) AS revised`,
        [JSON.stringify(input)],
      );
      if (result.rows[0]?.revised !== true) return false;
      await this.#publishLineage(
        client,
        { ...item, stateRevision: input.expectedStateRevision + 1 },
        `state:${input.expectedStateRevision}`,
        input.updatedAt,
      );
      return true;
    });
  }

  async #findOne(
    learningProfileId: string,
    predicate: string,
    value: string,
  ): Promise<StoredWrongItem | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<WrongItemRow>(
        `${this.#select()} WHERE learning_profile_id = $1 AND ${predicate}`,
        [learningProfileId, value],
      );
      return result.rows[0] ? this.#hydrate(client, result.rows[0]) : null;
    });
  }

  async #hydrate(client: PoolClient, row: WrongItemRow): Promise<StoredWrongItem> {
    const [reasons, corrections] = await Promise.all([
      client.query<ReasonRow>(
        `SELECT id, revision, action, actor_type, actor_id,
                category, explanation, reason, changed_at
         FROM learning.wrong_item_reason_revisions
         WHERE wrong_item_id = $1
         ORDER BY revision`,
        [row.id],
      ),
      client.query<CorrectionRow>(
        `SELECT id, idempotency_key, assessment_version_id, basis,
                response_text, normalized_response, outcome, created_at
         FROM learning.immediate_correction_attempts
         WHERE wrong_item_id = $1
         ORDER BY created_at, id`,
        [row.id],
      ),
    ]);
    return {
      assessment: json(row.assessment_snapshot),
      classification: json(row.classification),
      correctionAttempts: corrections.rows.map((attempt) => ({
        assessmentVersionId: attempt.assessment_version_id,
        basis: json(attempt.basis),
        createdAt: timestamp(attempt.created_at),
        id: attempt.id,
        idempotencyKey: attempt.idempotency_key,
        normalizedResponse: attempt.normalized_response,
        outcome: attempt.outcome,
        responseText: attempt.response_text,
      })),
      createdAt: timestamp(row.created_at),
      deduplicationKey: row.deduplication_key,
      familySpaceId: row.family_space_id,
      firstIncorrectAt: timestamp(row.first_incorrect_at),
      id: row.id,
      learningProfileId: row.learning_profile_id,
      reasonCandidate: json(row.reason_candidate),
      reasonHistory: reasons.rows.map((revision) => ({
        action: revision.action,
        actor: { id: revision.actor_id, type: revision.actor_type },
        category: revision.category,
        changedAt: timestamp(revision.changed_at),
        explanation: revision.explanation,
        id: revision.id,
        reason: revision.reason,
        revision: revision.revision,
      })),
      stateRevision: row.state_revision,
      status: row.status,
      themeId: row.theme_id,
      updatedAt: timestamp(row.updated_at),
    };
  }

  async #mutate(
    learningProfileId: string,
    wrongItemId: string,
    operation: (client: PoolClient, item: StoredWrongItem) => Promise<boolean>,
  ): Promise<boolean> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<WrongItemRow>(
        `${this.#select()} WHERE learning_profile_id = $1 AND id = $2`,
        [learningProfileId, wrongItemId],
      );
      if (!result.rows[0]) return false;
      const item = await this.#hydrate(client, result.rows[0]);
      await this.#setFamily(client, item.familySpaceId);
      return operation(client, item);
    });
  }

  async #publishLineage(
    client: PoolClient,
    item: StoredWrongItem,
    expectedPreviousVersion: string | null,
    occurredAt: string,
  ): Promise<void> {
    const scope = {
      familySpaceId: item.familySpaceId,
      learningProfileId: item.learningProfileId,
    };
    const dependencies: SourceDependency[] = [];
    const sync = async (
      id: string,
      kind: SourceDependency['source']['kind'],
      version: string,
      reason: string,
      usage: string,
    ) => {
      const source = await syncSourceRevisionInTransaction(client, {
        occurredAt,
        reason,
        source: { ...scope, id, kind },
        version,
      });
      dependencies.push({ source, usage });
    };
    await sync(
      item.assessment.materialId,
      'confirmed_content',
      item.assessment.inputReference.confirmedContentVersionId,
      'wrong item confirmed content snapshot',
      'confirmed_content',
    );
    await sync(
      item.assessment.materialId,
      'current_learning_basis',
      basisLineageVersion(item),
      'wrong item current learning basis snapshot',
      'current_learning_basis',
    );
    await sync(
      `${item.assessment.materialId}:${item.assessment.inputReference.questionRegionId}`,
      'question',
      item.assessment.question.versionId,
      'wrong item question version',
      'question',
    );
    await sync(
      `${item.assessment.materialId}:${item.assessment.inputReference.responseRegionId}`,
      'response',
      item.assessment.response.versionId,
      'wrong item response version',
      'response',
    );
    await sync(
      `${item.assessment.materialId}:${item.assessment.question.versionId}`,
      'grading_basis',
      item.assessment.correctBasis.gradingRuleVersionId,
      'wrong item grading basis version',
      'grading_basis',
    );
    const publication = {
      artifact: {
        ...scope,
        id: item.id,
        kind: 'error_item' as const,
        rebuildable: true,
        version: `state:${item.stateRevision}`,
      },
      commandId: `lineage:wrong-item:${item.id}:state:${item.stateRevision}`,
      dependencies,
      expectedPreviousVersion,
      occurredAt,
    };
    const saved = await publishArtifactInTransaction(client, publication, {
      commandId: publication.commandId,
      fingerprint: sourceLineageFingerprint(publication),
    });
    if (saved.status === 'conflict' || saved.status === 'idempotency_conflict') {
      throw new Error('Wrong item lineage publication conflicted');
    }
  }

  #select(): string {
    return `SELECT id, family_space_id, learning_profile_id, material_id,
                   assessment_snapshot, classification, theme_id, reason_candidate,
                   status, first_incorrect_at, state_revision,
                   deduplication_key, created_at, updated_at
            FROM learning.wrong_items`;
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

export function createPostgresLearningProgressStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresLearningProgressStore(pool) };
}
