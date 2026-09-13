import type {
  GamificationEvent,
  GamificationStore,
  GamificationScope,
} from '@rhea/learning-progress';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface EventRow extends QueryResultRow {
  authority_state: GamificationEvent['authorityState'];
  event_key: string;
  expires_at: Date | null;
  family_space_id: string;
  kind: GamificationEvent['kind'];
  learning_date: string | Date;
  learning_profile_id: string;
  occurred_at: Date;
  source_reference_id: string;
  source_version: string;
}

function event(row: EventRow): GamificationEvent {
  return {
    authorityState: row.authority_state,
    eventKey: row.event_key,
    expiresAt: row.expires_at?.toISOString() ?? null,
    familySpaceId: row.family_space_id,
    kind: row.kind,
    learningDate:
      typeof row.learning_date === 'string'
        ? row.learning_date.slice(0, 10)
        : row.learning_date.toISOString().slice(0, 10),
    learningProfileId: row.learning_profile_id,
    occurredAt: row.occurred_at.toISOString(),
    sourceReferenceId: row.source_reference_id,
    sourceVersion: row.source_version,
  };
}

export class PostgresGamificationStore implements GamificationStore {
  constructor(readonly pool: Pool) {}

  async listEvents(scope: GamificationScope): Promise<GamificationEvent[]> {
    return this.#withScope(scope, async (client) => {
      const result = await client.query<EventRow>(
        `SELECT family_space_id, learning_profile_id, event_key, kind,
                authority_state, learning_date, occurred_at, expires_at,
                source_reference_id, source_version
         FROM learning.gamification_events
         WHERE family_space_id = $1 AND learning_profile_id = $2
         ORDER BY occurred_at, event_key`,
        [scope.familySpaceId, scope.learningProfileId],
      );
      return result.rows.map(event);
    });
  }

  async recordEvent(input: GamificationEvent) {
    return this.#withScope(input, async (client) => {
      const result = await client.query<{ outcome: 'conflict' | 'recorded' | 'replayed' }>(
        `SELECT learning.record_gamification_event($1::jsonb) AS outcome`,
        [JSON.stringify(input)],
      );
      return result.rows[0]?.outcome ?? 'conflict';
    });
  }

  async updateAuthority(
    input: Parameters<GamificationStore['updateAuthority']>[0],
  ): Promise<'not_found' | 'updated'> {
    return this.#withScope(input, async (client) => {
      const result = await client.query<{ updated: boolean }>(
        `SELECT learning.update_gamification_event_authority($1::jsonb) AS updated`,
        [JSON.stringify(input)],
      );
      return result.rows[0]?.updated ? 'updated' : 'not_found';
    });
  }

  async #withScope<Value>(
    scope: GamificationScope,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_learning_progress_app');
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        scope.familySpaceId,
      ]);
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        scope.learningProfileId,
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
