import type {
  ChallengeRecord,
  ChallengeStore,
  ChallengeMatchPoolEntry,
  ConsumeInviteResult,
  DeidentifiedChallengeResult,
  PartnerInviteRecord,
  PartnerRelationRecord,
  SaveRandomChallengeResult,
} from '@rhea/challenge';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface JsonRow extends QueryResultRow {
  record: unknown;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

export class PostgresChallengeStore implements ChallengeStore {
  constructor(readonly pool: Pool) {}

  async saveInvite(record: PartnerInviteRecord): Promise<void> {
    await this.#withProfile(
      record.creator.learningProfileId,
      record.creator.familySpaceId,
      (client) =>
        client.query(
          `INSERT INTO learning.partner_invites
          (id, creator_family_space_id, creator_learning_profile_id, code_hash,
           record, created_at, expires_at, consumed_at, relation_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NULL, NULL)`,
          [
            record.id,
            record.creator.familySpaceId,
            record.creator.learningProfileId,
            record.codeHash,
            JSON.stringify(record),
            record.createdAt,
            record.expiresAt,
          ],
        ),
    );
  }

  async findInviteByHash(codeHash: string): Promise<PartnerInviteRecord | null> {
    return this.#withRole(async (client) => {
      const result = await client.query<{ record: unknown }>(
        `SELECT learning.read_partner_invite_by_hash($1) AS record`,
        [codeHash],
      );
      return result.rows[0]?.record ? json<PartnerInviteRecord>(result.rows[0].record) : null;
    });
  }

  async consumeInvite(input: {
    authorizationSnapshots: Array<{
      consentRevision: number;
      familySpaceId: string;
      grade: number;
      learningProfileId: string;
    }>;
    codeHash: string;
    consumedAt: string;
    inviteId: string;
    relation: PartnerRelationRecord;
  }): Promise<ConsumeInviteResult> {
    const receiver = input.relation.participants[1]!;
    return this.#withProfile(receiver.learningProfileId, receiver.familySpaceId, async (client) => {
      const result = await client.query<{ outcome: unknown }>(
        `SELECT learning.consume_partner_invite($1::jsonb) AS outcome`,
        [JSON.stringify(input)],
      );
      return json<ConsumeInviteResult>(result.rows[0]!.outcome);
    });
  }

  async findRelation(id: string, learningProfileId: string): Promise<PartnerRelationRecord | null> {
    return this.#withProfile(learningProfileId, null, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT record FROM learning.partner_relations WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? json<PartnerRelationRecord>(result.rows[0].record) : null;
    });
  }

  async listRelations(learningProfileId: string): Promise<PartnerRelationRecord[]> {
    return this.#withProfile(learningProfileId, null, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT record
         FROM learning.partner_relations
         WHERE $1::uuid IN (
           participant_a_learning_profile_id,
           participant_b_learning_profile_id
         )
         ORDER BY created_at, id`,
        [learningProfileId],
      );
      return result.rows.map((row) => json<PartnerRelationRecord>(row.record));
    });
  }

  async saveRelation(record: PartnerRelationRecord): Promise<void> {
    const participant = record.participants[0]!;
    await this.#withProfile(participant.learningProfileId, participant.familySpaceId, (client) =>
      client.query(
        `UPDATE learning.partner_relations
         SET status = $2, record = $3::jsonb, dissolved_at = $4
         WHERE id = $1`,
        [record.id, record.status, JSON.stringify(record), record.dissolvedAt],
      ),
    );
  }

  async saveChallenge(record: ChallengeRecord, expectedVersion: number | null): Promise<boolean> {
    const participant = record.packs[0];
    const familySpaceId = record.authorizationSnapshots.find(
      (snapshot) => snapshot.learningProfileId === participant?.learningProfileId,
    )?.familySpaceId;
    if (!participant || !familySpaceId) throw new Error('Challenge participant scope is missing');
    return this.#withProfile(participant.learningProfileId, familySpaceId, async (client) => {
      if (expectedVersion === null) {
        const authorized = await client.query<{ current: boolean }>(
          `SELECT learning.challenge_authorizations_current($1::jsonb) AS current`,
          [JSON.stringify(record.authorizationSnapshots)],
        );
        if (authorized.rows[0]?.current !== true) return false;
        const inserted = await client.query(
          `INSERT INTO learning.challenge_matches
            (id, relation_id, participant_a_learning_profile_id,
             participant_b_learning_profile_id, status, version,
             capability_version_id, authorization_decision_id, record,
             created_at, cancelled_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
           FROM learning.partner_relations relation
           WHERE relation.id = $2
             AND relation.status = 'active'
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            record.id,
            record.relationId,
            record.packs[0]!.learningProfileId,
            record.packs[1]!.learningProfileId,
            record.status,
            record.version,
            record.capabilityVersionId,
            record.authorizationDecisionId,
            JSON.stringify(record),
            record.createdAt,
            record.cancelledAt,
          ],
        );
        if (inserted.rowCount !== 1) return false;
        for (const pack of record.packs) {
          for (const [position, item] of pack.items.entries()) {
            await client.query(
              `INSERT INTO learning.challenge_items
                (challenge_id, learning_profile_id, item_id, position, item)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [record.id, pack.learningProfileId, item.id, position, JSON.stringify(item)],
            );
          }
        }
        return true;
      }
      const authorized = await client.query<{ current: boolean }>(
        `SELECT learning.challenge_authorizations_current($1::jsonb) AS current`,
        [JSON.stringify(record.authorizationSnapshots)],
      );
      if (authorized.rows[0]?.current !== true) return false;
      const updated = await client.query(
        `UPDATE learning.challenge_matches
         SET status = $3, version = $4, record = $5::jsonb, cancelled_at = $6
         WHERE id = $1 AND version = $2
         RETURNING id`,
        [
          record.id,
          expectedVersion,
          record.status,
          record.version,
          JSON.stringify(record),
          record.cancelledAt,
        ],
      );
      if (updated.rowCount !== 1) return false;
      for (const answer of record.answers) {
        await client.query(
          `INSERT INTO learning.challenge_attempts
            (challenge_id, learning_profile_id, item_id, command_id,
             answer, correct, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            record.id,
            answer.learningProfileId,
            answer.itemId,
            answer.commandId,
            answer.answer,
            answer.correct,
            answer.submittedAt,
          ],
        );
      }
      return true;
    });
  }

  async getChallenge(id: string, learningProfileId: string): Promise<ChallengeRecord | null> {
    return this.#withProfile(learningProfileId, null, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT record FROM learning.challenge_matches WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? json<ChallengeRecord>(result.rows[0].record) : null;
    });
  }

  async listChallenges(learningProfileId: string): Promise<ChallengeRecord[]> {
    return this.#withProfile(learningProfileId, null, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT record
         FROM learning.challenge_matches
         WHERE $1::uuid IN (
           participant_a_learning_profile_id,
           participant_b_learning_profile_id
         )
         ORDER BY created_at DESC, id`,
        [learningProfileId],
      );
      return result.rows.map((row) => json<ChallengeRecord>(row.record));
    });
  }

  async saveMatchPoolEntry(entry: ChallengeMatchPoolEntry): Promise<boolean> {
    return this.#withProfile(
      entry.actor.learningProfileId,
      entry.actor.familySpaceId,
      async (client) => {
        const result = await client.query(
          `INSERT INTO learning.random_match_entries (
             entry_id, family_space_id, learning_profile_id, grade, status,
             challenge_id, record, entered_at, expires_at
           ) VALUES ($1, $2, $3, $4, 'waiting', NULL, $5::jsonb, $6, $7)
           ON CONFLICT (learning_profile_id) DO UPDATE
           SET entry_id = EXCLUDED.entry_id,
               family_space_id = EXCLUDED.family_space_id,
               grade = EXCLUDED.grade,
               status = 'waiting',
               challenge_id = NULL,
               record = EXCLUDED.record,
               entered_at = EXCLUDED.entered_at,
               expires_at = EXCLUDED.expires_at
           WHERE learning.random_match_entries.status <> 'matched'`,
          [
            entry.entryId,
            entry.actor.familySpaceId,
            entry.actor.learningProfileId,
            entry.grade,
            JSON.stringify(entry),
            entry.enteredAt,
            entry.expiresAt,
          ],
        );
        return result.rowCount === 1;
      },
    );
  }

  async saveRandomChallenge(
    record: ChallengeRecord,
    entries: ChallengeMatchPoolEntry[],
  ): Promise<SaveRandomChallengeResult> {
    const participant = entries[1] ?? entries[0];
    if (!participant) return 'conflict';
    return this.#withProfile(
      participant.actor.learningProfileId,
      participant.actor.familySpaceId,
      async (client) => {
        const result = await client.query<{ outcome: SaveRandomChallengeResult }>(
          `SELECT learning.create_random_challenge($1::jsonb, $2::jsonb) AS outcome`,
          [JSON.stringify(record), JSON.stringify(entries)],
        );
        return result.rows[0]?.outcome ?? 'conflict';
      },
    );
  }

  async finalizeRandomChallenge(input: {
    challenge: ChallengeRecord;
    expectedVersion: number;
    reportedByProfileId: string | null;
    reportReason: string | null;
    results: DeidentifiedChallengeResult[];
  }): Promise<boolean> {
    const participant =
      input.challenge.authorizationSnapshots.find(
        (snapshot) => snapshot.learningProfileId === input.reportedByProfileId,
      ) ?? input.challenge.authorizationSnapshots[0];
    if (!participant) return false;
    return this.#withProfile(
      participant.learningProfileId,
      participant.familySpaceId,
      async (client) => {
        const result = await client.query<{ finalized: boolean }>(
          `SELECT learning.finalize_random_challenge($1::jsonb) AS finalized`,
          [JSON.stringify(input)],
        );
        return result.rows[0]?.finalized === true;
      },
    );
  }

  async getChallengeResult(
    id: string,
    learningProfileId: string,
  ): Promise<DeidentifiedChallengeResult | null> {
    return this.#withProfile(learningProfileId, null, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT record
         FROM learning.deidentified_challenge_results
         WHERE challenge_id = $1 AND owner_learning_profile_id = $2`,
        [id, learningProfileId],
      );
      return result.rows[0] ? json<DeidentifiedChallengeResult>(result.rows[0].record) : null;
    });
  }

  async listChallengeResults(learningProfileId: string): Promise<DeidentifiedChallengeResult[]> {
    return this.#withProfile(learningProfileId, null, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT record
         FROM learning.deidentified_challenge_results
         WHERE owner_learning_profile_id = $1
         ORDER BY ended_at DESC, challenge_id`,
        [learningProfileId],
      );
      return result.rows.map((row) => json<DeidentifiedChallengeResult>(row.record));
    });
  }

  async listDueRandomChallenges(dueAt: string, limit: number): Promise<ChallengeRecord[]> {
    return this.#withRole(async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT learning.read_due_random_challenges($1, $2) AS record`,
        [dueAt, limit],
      );
      return result.rows.map((row) => json<ChallengeRecord>(row.record));
    });
  }

  async #withProfile<Value>(
    learningProfileId: string,
    familySpaceId: string | null,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    return this.#withRole(async (client) => {
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        learningProfileId,
      ]);
      if (familySpaceId) {
        await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
      }
      return operation(client);
    });
  }

  async #withRole<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_challenge_app');
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

export function createPostgresChallengeStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresChallengeStore(pool) };
}
