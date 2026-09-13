import { randomUUID } from 'node:crypto';

import {
  ChallengeService,
  MemoryChallengeAuthorization,
  MemoryChallengeMatchPool,
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
  const carol: ChallengeActor = {
    familySpaceId: randomUUID(),
    learningProfileId: randomUUID(),
  };
  const dora: ChallengeActor = {
    familySpaceId: randomUUID(),
    learningProfileId: randomUUID(),
  };

  beforeAll(async () => {
    await applyMigrations(pool!, await loadDefaultMigrations());
    for (const [actor, name, guardianId, grade] of [
      [alice, 'Alice', randomUUID(), 3],
      [bob, 'Bob', randomUUID(), 3],
      [carol, 'Carol', randomUUID(), 3],
      [dora, 'Dora', randomUUID(), 4],
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
         VALUES ($1, $2, $3, $4, 'integration-test')`,
        [actor.learningProfileId, actor.familySpaceId, name, grade],
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

  it('persists grade-only random matching and deidentifies immediately on report', async () => {
    const authorization = new MemoryChallengeAuthorization([
      { ...alice, consentRevision: 1, grade: 3, status: 'granted' },
      { ...bob, consentRevision: 1, grade: 3, status: 'granted' },
      { ...carol, consentRevision: 1, grade: 3, status: 'granted' },
      { ...dora, consentRevision: 1, grade: 4, status: 'granted' },
    ]);
    const store = new PostgresChallengeStore(pool!);
    const service = new ChallengeService({
      authorization,
      identityFactory: () => ({ avatarKey: 'safe-planet', nickname: '星球搭档' }),
      invitationPepper: 'integration-test-pepper-is-long-enough',
      matchPool: new MemoryChallengeMatchPool(),
      packFactory: {
        async createEquivalentPacks({ participants }) {
          return {
            authorizationDecisionId: `random-decision-${suffix}`,
            capabilityVersionId: `random-capability-${suffix}`,
            packs: participants.map((participant, index) => ({
              items: [
                {
                  difficulty: 'foundation' as const,
                  gradingRule: { expected: String(index + 2), kind: 'numeric' as const },
                  id: `random-item-${index}-${suffix}`,
                  knowledgePoint: '加法',
                  prompt: index === 0 ? '1+1=?' : '1+2=?',
                },
              ],
              learningProfileId: participant.learningProfileId,
            })),
          };
        },
      },
      pairAvoidancePepper: 'integration-avoidance-pepper-long-enough',
      store,
    });

    await expect(service.enterMatchPool({ actor: dora })).resolves.toMatchObject({
      grade: 4,
      status: 'waiting',
    });
    await expect(service.enterMatchPool({ actor: alice })).resolves.toMatchObject({
      grade: 3,
      status: 'waiting',
    });
    const match = await service.enterMatchPool({ actor: bob });
    expect(match.status).toBe('matched');
    if (match.status !== 'matched') throw new Error('expected random match');
    expect(match.challenge).toMatchObject({ mode: 'random', relationId: null });
    expect(JSON.stringify(match.challenge)).not.toContain(alice.learningProfileId);

    const reported = await service.reportRandomChallenge({
      actor: alice,
      challengeId: match.challenge.id,
      reason: 'uncomfortable',
    });
    expect(reported).toMatchObject({
      endedReason: 'reported',
      noPenalty: true,
      opponentIdentity: null,
      status: 'cancelled',
    });
    expect(JSON.stringify(reported)).not.toContain(bob.learningProfileId);

    const persistence = await pool!.query<{
      active_matches: string;
      avoidance_tokens: string;
      identity_mappings: string;
      owner_results: string;
      safety_reports: string;
    }>(
      `SELECT
         (SELECT count(*) FROM learning.challenge_matches WHERE id = $1)::text AS active_matches,
         (SELECT count(*) FROM learning.random_match_identity_mappings WHERE challenge_id = $1)::text AS identity_mappings,
         (SELECT count(*) FROM learning.deidentified_challenge_results WHERE challenge_id = $1)::text AS owner_results,
         (SELECT count(*) FROM learning.pair_avoidance_tokens WHERE reason = 'reported')::text AS avoidance_tokens,
         (SELECT count(*) FROM safety.challenge_reports WHERE challenge_id = $1)::text AS safety_reports`,
      [match.challenge.id],
    );
    expect(persistence.rows[0]).toEqual({
      active_matches: '0',
      avoidance_tokens: '1',
      identity_mappings: '0',
      owner_results: '2',
      safety_reports: '1',
    });

    const challengeClient = await pool!.connect();
    try {
      await challengeClient.query('BEGIN');
      await challengeClient.query('SET LOCAL ROLE rhea_challenge_app');
      await expect(
        challengeClient.query('SELECT * FROM safety.challenge_reports'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await challengeClient.query('ROLLBACK');
    } finally {
      challengeClient.release();
    }

    await service.enterMatchPool({ actor: alice });
    await expect(service.enterMatchPool({ actor: bob })).resolves.toMatchObject({
      status: 'waiting',
    });
  });
});
