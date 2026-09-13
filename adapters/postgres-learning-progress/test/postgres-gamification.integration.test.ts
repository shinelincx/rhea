import { randomUUID } from 'node:crypto';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { GamificationService } from '@rhea/learning-progress';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresGamificationStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

describeWithDatabase('Postgres gamification adapter', () => {
  const familySpaceId = randomUUID();
  const profileId = randomUUID();
  const otherProfileId = randomUUID();
  beforeAll(async () => {
    await applyMigrations(
      {
        query: async (sql, values) => {
          const result = await pool!.query(sql, values);
          return { rows: result.rows };
        },
      },
      await loadDefaultMigrations(),
    );
    await pool!.query('INSERT INTO learning.family_spaces(id,name) VALUES($1,$2)', [
      familySpaceId,
      '成长集成家庭',
    ]);
    await pool!.query(
      "INSERT INTO learning.learning_profiles(id,family_space_id,display_name,grade,pin_hash) VALUES($1,$2,'小禾',4,'hash'),($3,$2,'小川',4,'hash')",
      [profileId, familySpaceId, otherProfileId],
    );
  });
  afterAll(async () => {
    await pool?.query('DELETE FROM learning.family_spaces WHERE id=$1', [familySpaceId]);
    await pool?.end();
  });
  it('persists one reward for replays and enforces profile RLS', async () => {
    const service = new GamificationService({
      clock: { now: new Date('2026-09-14T00:00:00.000Z') },
      store: new PostgresGamificationStore(pool!),
    });
    const event = {
      authorityState: 'accepted_current' as const,
      eventKey: 'pg-event-1',
      expiresAt: null,
      familySpaceId,
      kind: 'learning_evidence_independent' as const,
      learningDate: '2026-09-13',
      learningProfileId: profileId,
      occurredAt: '2026-09-13T01:00:00.000Z',
      sourceReferenceId: 'evidence-1',
      sourceVersion: 'v1',
    };
    expect((await service.recordEvent(event)).status).toBe('recorded');
    expect((await service.recordEvent(event)).status).toBe('replayed');
    expect((await service.getGrowth({ familySpaceId, learningProfileId: profileId })).xp).toBe(20);
    expect((await service.getGrowth({ familySpaceId, learningProfileId: otherProfileId })).xp).toBe(
      0,
    );
    const privileges = await pool!.query(
      "SELECT has_schema_privilege('rhea_learning_progress_app','safety','USAGE') AS safety",
    );
    expect(privileges.rows[0]).toEqual({ safety: false });
  });
});
