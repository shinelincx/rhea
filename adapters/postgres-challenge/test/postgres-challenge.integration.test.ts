import { createHmac, randomUUID } from 'node:crypto';

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

import { LocalChallengeReportFieldProtector, PostgresChallengeStore } from '../src/index.js';

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
    const mappingProtector = new LocalChallengeReportFieldProtector();
    const store = new PostgresChallengeStore(
      pool!,
      'local-safety-token-pepper-at-least-32-bytes',
      mappingProtector,
    );
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
    const sourceReferenceToken = createHmac('sha256', 'local-safety-token-pepper-at-least-32-bytes')
      .update(`safety-source\0challenge_event\0${match.challenge.id}:report`)
      .digest('hex');

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
         (SELECT count(*) FROM safety.challenge_reports WHERE source_reference_token = $2)::text AS safety_reports`,
      [match.challenge.id, sourceReferenceToken],
    );
    expect(persistence.rows[0]).toEqual({
      active_matches: '0',
      avoidance_tokens: '1',
      identity_mappings: '0',
      owner_results: '2',
      safety_reports: '1',
    });
    const protectedReport = await pool!.query<{
      age_band: string;
      challenge_id: string | null;
      id: string;
      participant_a_learning_profile_id: string | null;
      participant_b_learning_profile_id: string | null;
      reporter_subject_token: string;
      reporter_learning_profile_id: string | null;
      source_reference_token: string;
      subject_tokens: string[];
    }>(
      `SELECT id,challenge_id,reporter_learning_profile_id,participant_a_learning_profile_id,
              participant_b_learning_profile_id,subject_tokens,reporter_subject_token,
              source_reference_token,age_band
       FROM safety.challenge_reports WHERE source_reference_token=$1`,
      [sourceReferenceToken],
    );
    expect(protectedReport.rows[0]).toEqual({
      age_band: 'middle_primary',
      challenge_id: null,
      id: expect.any(String),
      participant_a_learning_profile_id: null,
      participant_b_learning_profile_id: null,
      reporter_learning_profile_id: null,
      reporter_subject_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      source_reference_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      subject_tokens: [
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ],
    });
    expect(new Set(protectedReport.rows[0]!.subject_tokens).size).toBe(2);
    expect(JSON.stringify(protectedReport.rows)).not.toContain(alice.learningProfileId);
    expect(JSON.stringify(protectedReport.rows)).not.toContain(bob.learningProfileId);
    const safetyOutbox = await pool!.query(
      `SELECT subject_token,source_reference_id,report_reason,age_band,status,attempts
       FROM safety.challenge_report_classification_outbox WHERE source_reference_id=$1`,
      [sourceReferenceToken],
    );
    expect(safetyOutbox.rows).toEqual([
      {
        age_band: 'middle_primary',
        attempts: 0,
        report_reason: 'uncomfortable',
        source_reference_id: protectedReport.rows[0]!.source_reference_token,
        status: 'pending',
        subject_token: protectedReport.rows[0]!.reporter_subject_token,
      },
    ]);
    expect(JSON.stringify(safetyOutbox.rows)).not.toContain(alice.learningProfileId);
    expect(JSON.stringify(safetyOutbox.rows)).not.toContain(bob.learningProfileId);
    expect(JSON.stringify(protectedReport.rows)).not.toContain(match.challenge.id);
    expect(JSON.stringify(safetyOutbox.rows)).not.toContain(match.challenge.id);

    const operatorClient = await pool!.connect();
    let mappingRows: Array<{
      mapping_role: 'participant' | 'reporter';
      protected_context: Buffer;
      protection_key_id: string;
      subject_token: string;
    }> = [];
    try {
      await operatorClient.query('BEGIN');
      await operatorClient.query('SET LOCAL ROLE rhea_safety_operator');
      mappingRows = (
        await operatorClient.query(
          `SELECT subject_token,mapping_role,protected_context,protection_key_id
           FROM safety.read_challenge_report_subject_mappings($1,$2,$3,now())`,
          [
            protectedReport.rows[0]!.id,
            'integration-safety-operator',
            '调查挑战举报并执行账号保护措施',
          ],
        )
      ).rows;
      await operatorClient.query('COMMIT');
    } catch (error) {
      await operatorClient.query('ROLLBACK');
      throw error;
    } finally {
      operatorClient.release();
    }
    expect(mappingRows).toHaveLength(2);
    expect(JSON.stringify(mappingRows)).not.toContain(alice.learningProfileId);
    expect(JSON.stringify(mappingRows)).not.toContain(bob.learningProfileId);
    const recovered = await Promise.all(
      mappingRows.map(async (row) => ({
        ...(JSON.parse(
          Buffer.from(await mappingProtector.unprotect(row.protected_context)).toString('utf8'),
        ) as { familySpaceId: string; learningProfileId: string }),
        mappingRole: row.mapping_role,
      })),
    );
    expect(recovered).toEqual(
      expect.arrayContaining([
        { ...alice, mappingRole: 'reporter' },
        { ...bob, mappingRole: 'participant' },
      ]),
    );
    expect(
      (
        await pool!.query(
          'SELECT operator_id,reason,result_count FROM safety.challenge_report_mapping_access_audit WHERE report_id=$1',
          [protectedReport.rows[0]!.id],
        )
      ).rows,
    ).toEqual([
      {
        operator_id: 'integration-safety-operator',
        reason: '调查挑战举报并执行账号保护措施',
        result_count: 2,
      },
    ]);

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
