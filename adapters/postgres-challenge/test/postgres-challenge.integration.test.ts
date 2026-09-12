import { randomUUID } from 'node:crypto';

import {
  ChallengeService,
  MemoryChallengeAuthorization,
  type ChallengeActor,
  type ChallengePackFactory,
} from '@rhea/challenge';
import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresChallengeStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

describeWithDatabase('PostgresChallengeStore', () => {
  const suffix = randomUUID();
  const alice: ChallengeActor = {
    familySpaceId: randomUUID(),
    learningProfileId: randomUUID(),
  };
  const bob: ChallengeActor = {
    familySpaceId: randomUUID(),
    learningProfileId: randomUUID(),
  };

  beforeAll(async () => {
    await applyMigrations(pool!, await loadDefaultMigrations());
    for (const [actor, name, guardianId] of [
      [alice, 'Alice', randomUUID()],
      [bob, 'Bob', randomUUID()],
    ] as const) {
      await pool!.query(`INSERT INTO learning.guardians (id, identity_subject) VALUES ($1, $2)`, [
        guardianId,
        `challenge-${name}-${suffix}`,
      ]);
      await pool!.query(`INSERT INTO learning.family_spaces (id, name) VALUES ($1, $2)`, [
        actor.familySpaceId,
        `${name}-${suffix}`,
      ]);
      await pool!.query(
        `INSERT INTO learning.learning_profiles
          (id, family_space_id, display_name, grade, pin_hash)
         VALUES ($1, $2, $3, 3, 'integration-test')`,
        [actor.learningProfileId, actor.familySpaceId, name],
      );
      await pool!.query(
        `INSERT INTO learning.family_consents
          (family_space_id, kind, status, statement_version, revision,
           updated_by_guardian_id, updated_at)
         VALUES ($1, 'peer_challenge', 'granted', 'peer-challenge-v1', 1, $2, now())`,
        [actor.familySpaceId, guardianId],
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('atomically consumes a cross-family invite and persists resumable private packs', async () => {
    const authorization = new MemoryChallengeAuthorization([
      { ...alice, consentRevision: 1, grade: 3, status: 'granted' },
      { ...bob, consentRevision: 1, grade: 3, status: 'granted' },
    ]);
    const packFactory: ChallengePackFactory = {
      async createEquivalentPacks({ participants }) {
        return {
          authorizationDecisionId: `decision-${suffix}`,
          capabilityVersionId: `capability-${suffix}`,
          packs: participants.map((participant, index) => ({
            items: [
              {
                difficulty: 'foundation',
                gradingRule: { expected: index === 0 ? '2' : '3', kind: 'numeric' },
                id: `item-${index}-${suffix}`,
                knowledgePoint: '加法',
                prompt: index === 0 ? '1+1=?' : '1+2=?',
              },
            ],
            learningProfileId: participant.learningProfileId,
          })),
        };
      },
    };
    const service = new ChallengeService({
      authorization,
      invitationPepper: 'integration-test-pepper-is-long-enough',
      packFactory,
      store: new PostgresChallengeStore(pool!),
    });

    const invite = await service.createPartnerInvite({ actor: alice });
    const relation = await service.redeemPartnerInvite({ actor: bob, code: invite.code });
    await expect(
      service.redeemPartnerInvite({ actor: bob, code: invite.code }),
    ).rejects.toMatchObject({ code: 'INVITE_ALREADY_USED' });
    const challenge = await service.createChallenge({
      actor: alice,
      relationId: relation.id,
      subject: 'mathematics',
      target: '加法',
    });
    const scopedClient = await pool!.connect();
    try {
      await scopedClient.query('BEGIN');
      await scopedClient.query('SET LOCAL ROLE rhea_challenge_app');
      await scopedClient.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        bob.learningProfileId,
      ]);
      const visibleItems = await scopedClient.query<{ prompt: string }>(
        `SELECT item ->> 'prompt' AS prompt
         FROM learning.challenge_items
         WHERE challenge_id = $1
         ORDER BY position`,
        [challenge.id],
      );
      expect(visibleItems.rows.map((row) => row.prompt)).toEqual(['1+2=?']);
      await scopedClient.query('ROLLBACK');
    } finally {
      scopedClient.release();
    }
    await service.submitAnswer({
      actor: alice,
      answer: '2',
      challengeId: challenge.id,
      commandId: `answer-a-${suffix}`,
      itemId: `item-0-${suffix}`,
    });

    const bobView = await service.getChallenge({ actor: bob, challengeId: challenge.id });
    expect(bobView.items[0]?.prompt).toBe('1+2=?');
    expect(JSON.stringify(bobView)).not.toContain('1+1=?');
    expect(bobView.opponentProgress.completedItems).toBe(1);
  });
});
