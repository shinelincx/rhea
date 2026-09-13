import { randomUUID } from 'node:crypto';

import type { ChallengeMatchPoolEntry } from '@rhea/challenge';
import { afterAll, describe, expect, it } from 'vitest';

import { RedisChallengeMatchPool } from '../src/index.js';

const describeWithRedis = process.env.REDIS_URL ? describe : describe.skip;
const prefix = `rhea:test:match:${randomUUID()}`;
const pool = process.env.REDIS_URL
  ? new RedisChallengeMatchPool({ keyPrefix: prefix, redisUrl: process.env.REDIS_URL })
  : undefined;

function entry(profile: string, grade: number): ChallengeMatchPoolEntry {
  return {
    actor: { familySpaceId: `family-${profile}`, learningProfileId: profile },
    enteredAt: new Date().toISOString(),
    entryId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grade,
  };
}

afterAll(async () => {
  await pool?.close();
});

describeWithRedis('RedisChallengeMatchPool', () => {
  it('atomically pairs candidates in the same grade bucket only', async () => {
    const gradeThreeA = entry(`alice-${randomUUID()}`, 3);
    const gradeFour = entry(`dora-${randomUUID()}`, 4);
    const gradeThreeB = entry(`bob-${randomUUID()}`, 3);

    await expect(pool!.enter(gradeThreeA)).resolves.toEqual({ kind: 'waiting' });
    await expect(pool!.enter(gradeFour)).resolves.toEqual({ kind: 'waiting' });
    await expect(pool!.enter(gradeThreeB)).resolves.toEqual({
      kind: 'candidate',
      opponent: gradeThreeA,
    });
  });
});
