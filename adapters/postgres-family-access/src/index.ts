import type {
  DeviceRecord,
  FamilyAccessStore,
  GuardianRecord,
  LearningProfile,
  LearningProfileRecord,
  SessionRecord,
} from '@rhea/family-access';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface PostgresFamilyAccessStoreOptions {
  pool: Pool;
}

interface SessionRow extends QueryResultRow {
  actor_type: 'guardian' | 'learner';
  device_id: string | null;
  expires_at: Date;
  family_space_id: string | null;
  guardian_id: string | null;
  id: string;
  learning_profile_id: string | null;
  revoked_at: Date | null;
  token_hash: string;
}

interface LearningProfileRow extends QueryResultRow {
  display_name: string;
  failed_pin_attempts: number;
  family_space_id: string;
  grade: number | null;
  id: string;
  pin_hash: string;
  pin_locked_until: Date | null;
}

async function setContext(client: PoolClient, context: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(context)) {
    await client.query('SELECT set_config($1, $2, true)', [`rhea.${name}`, value]);
  }
}

function toProfile(row: LearningProfileRow): LearningProfileRecord {
  return {
    displayName: row.display_name,
    failedPinAttempts: row.failed_pin_attempts,
    familySpaceId: row.family_space_id,
    grade: row.grade as LearningProfileRecord['grade'],
    id: row.id,
    pinHash: row.pin_hash,
    pinLockedUntil: row.pin_locked_until,
  };
}

export class PostgresFamilyAccessStore implements FamilyAccessStore {
  readonly #pool: Pool;

  constructor(options: PostgresFamilyAccessStoreOptions) {
    this.#pool = options.pool;
  }

  async createDevice(record: DeviceRecord): Promise<void> {
    await this.#withContext({ family_space_id: record.familySpaceId }, async (client) => {
      await client.query(
        `INSERT INTO learning.registered_devices
          (id, family_space_id, label, token_hash, revoked_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.id, record.familySpaceId, record.label, record.tokenHash, record.revokedAt],
      );
    });
  }

  async createFamilyWithManagingGuardian(input: {
    familySpace: { id: string; name: string };
    guardianId: string;
  }): Promise<void> {
    await this.#withContext(
      { family_space_id: input.familySpace.id, guardian_id: input.guardianId },
      async (client) => {
        await client.query('INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)', [
          input.familySpace.id,
          input.familySpace.name,
        ]);
        await client.query(
          `INSERT INTO learning.guardian_memberships
            (family_space_id, guardian_id, role, status)
           VALUES ($1, $2, 'managing', 'active')`,
          [input.familySpace.id, input.guardianId],
        );
      },
    );
  }

  async createLearningProfile(profile: LearningProfileRecord): Promise<void> {
    await this.#withContext({ family_space_id: profile.familySpaceId }, async (client) => {
      await client.query(
        `INSERT INTO learning.learning_profiles
          (id, family_space_id, display_name, grade, pin_hash, failed_pin_attempts, pin_locked_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          profile.id,
          profile.familySpaceId,
          profile.displayName,
          profile.grade,
          profile.pinHash,
          profile.failedPinAttempts,
          profile.pinLockedUntil,
        ],
      );
    });
  }

  async createSession(session: SessionRecord): Promise<void> {
    const context =
      session.actor.type === 'guardian'
        ? { guardian_id: session.actor.guardianId }
        : { family_space_id: session.actor.familySpaceId };
    await this.#withContext(context, async (client) => {
      await client.query(
        `INSERT INTO learning.sessions
          (id, token_hash, actor_type, guardian_id, family_space_id,
           learning_profile_id, device_id, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          session.id,
          session.tokenHash,
          session.actor.type,
          session.actor.type === 'guardian' ? session.actor.guardianId : null,
          session.actor.type === 'learner' ? session.actor.familySpaceId : null,
          session.actor.type === 'learner' ? session.actor.learningProfileId : null,
          session.actor.type === 'learner' ? session.actor.deviceId : null,
          session.expiresAt,
          session.revokedAt,
        ],
      );
    });
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    return this.#withContext({ device_token_hash: tokenHash }, async (client) => {
      const result = await client.query<{
        family_space_id: string;
        id: string;
        label: string;
        revoked_at: Date | null;
        token_hash: string;
      }>(
        `SELECT id, family_space_id, label, token_hash, revoked_at
         FROM learning.registered_devices
         WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row
        ? {
            familySpaceId: row.family_space_id,
            id: row.id,
            label: row.label,
            revokedAt: row.revoked_at,
            tokenHash: row.token_hash,
          }
        : null;
    });
  }

  async findLearningProfile(
    id: string,
    familySpaceId: string,
  ): Promise<LearningProfileRecord | null> {
    return this.#withContext({ family_space_id: familySpaceId }, async (client) => {
      const result = await client.query<LearningProfileRow>(
        `SELECT id, family_space_id, display_name, grade, pin_hash,
                failed_pin_attempts, pin_locked_until
         FROM learning.learning_profiles
         WHERE id = $1 AND family_space_id = $2`,
        [id, familySpaceId],
      );
      return result.rows[0] ? toProfile(result.rows[0]) : null;
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.#withContext({ session_token_hash: tokenHash }, async (client) => {
      const result = await client.query<SessionRow>(
        `SELECT id, token_hash, actor_type, guardian_id, family_space_id,
                learning_profile_id, device_id, expires_at, revoked_at
         FROM learning.sessions
         WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const actor =
        row.actor_type === 'guardian' && row.guardian_id
          ? { guardianId: row.guardian_id, type: 'guardian' as const }
          : row.device_id && row.family_space_id && row.learning_profile_id
            ? {
                deviceId: row.device_id,
                familySpaceId: row.family_space_id,
                learningProfileId: row.learning_profile_id,
                type: 'learner' as const,
              }
            : null;
      if (!actor) {
        throw new Error('Stored session actor is inconsistent');
      }
      return {
        actor,
        expiresAt: row.expires_at,
        id: row.id,
        revokedAt: row.revoked_at,
        tokenHash: row.token_hash,
      };
    });
  }

  async isManagingGuardian(guardianId: string, familySpaceId: string): Promise<boolean> {
    return this.#withContext(
      { family_space_id: familySpaceId, guardian_id: guardianId },
      async (client) => {
        const result = await client.query(
          `SELECT 1
           FROM learning.guardian_memberships
           WHERE guardian_id = $1 AND family_space_id = $2
             AND role = 'managing' AND status = 'active'`,
          [guardianId, familySpaceId],
        );
        return result.rowCount === 1;
      },
    );
  }

  async listLearningProfiles(familySpaceId: string): Promise<LearningProfile[]> {
    return this.#withContext({ family_space_id: familySpaceId }, async (client) => {
      const result = await client.query<LearningProfileRow>(
        `SELECT id, family_space_id, display_name, grade, pin_hash,
                failed_pin_attempts, pin_locked_until
         FROM learning.learning_profiles
         WHERE family_space_id = $1
         ORDER BY created_at, id`,
        [familySpaceId],
      );
      return result.rows.map((row) => {
        const profile = toProfile(row);
        return {
          displayName: profile.displayName,
          familySpaceId: profile.familySpaceId,
          grade: profile.grade,
          id: profile.id,
        };
      });
    });
  }

  async revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean> {
    return this.#withContext({ session_token_hash: tokenHash }, async (client) => {
      const result = await client.query(
        `UPDATE learning.sessions SET revoked_at = $2
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash, revokedAt],
      );
      return result.rowCount === 1;
    });
  }

  async savePinState(input: {
    failedPinAttempts: number;
    familySpaceId: string;
    learningProfileId: string;
    pinLockedUntil: Date | null;
  }): Promise<void> {
    await this.#withContext({ family_space_id: input.familySpaceId }, async (client) => {
      await client.query(
        `UPDATE learning.learning_profiles
         SET failed_pin_attempts = $3, pin_locked_until = $4
         WHERE id = $1 AND family_space_id = $2`,
        [
          input.learningProfileId,
          input.familySpaceId,
          input.failedPinAttempts,
          input.pinLockedUntil,
        ],
      );
    });
  }

  async upsertGuardian(identitySubject: string, proposedId: string): Promise<GuardianRecord> {
    return this.#withContext({ identity_subject: identitySubject }, async (client) => {
      const result = await client.query<{ id: string; identity_subject: string }>(
        `INSERT INTO learning.guardians (id, identity_subject)
         VALUES ($1, $2)
         ON CONFLICT (identity_subject)
         DO UPDATE SET identity_subject = EXCLUDED.identity_subject
         RETURNING id, identity_subject`,
        [proposedId, identitySubject],
      );
      const guardian = result.rows[0];
      if (!guardian) {
        throw new Error('Guardian upsert did not return a record');
      }
      return { id: guardian.id, identitySubject: guardian.identity_subject };
    });
  }

  async #withContext<Result>(
    context: Record<string, string>,
    action: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await setContext(client, context);
      const result = await action(client);
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

export function createPostgresFamilyAccessStore(databaseUrl: string): {
  pool: Pool;
  store: PostgresFamilyAccessStore;
} {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresFamilyAccessStore({ pool }) };
}
