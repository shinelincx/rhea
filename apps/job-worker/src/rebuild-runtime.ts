import process from 'node:process';

import type { ChallengeMatchPoolEntry } from '@rhea/challenge';
import { validateProductionTransportSecurity } from '@rhea/job-runtime';
import { BullMqJobClient } from '@rhea/queue-adapter';
import { RedisChallengeMatchPool } from '@rhea/redis-challenge-match';
import { Pool, type QueryResultRow } from 'pg';

interface RequestRow {
  id: string;
  learningProfileId: string;
}
interface RuntimeRebuildSnapshot {
  generatedLearning: RequestRow[];
  privacyTasks: Array<{ id: string }>;
  randomMatches: ChallengeMatchPoolEntry[];
  reviewCards: RequestRow[];
  submissions: RequestRow[];
  suggestedAssessments: RequestRow[];
}
interface SnapshotRow extends QueryResultRow {
  snapshot: RuntimeRebuildSnapshot;
}

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
validateProductionTransportSecurity(process.env);
const pool = new Pool({ connectionString: databaseUrl });
const aiQueue = new BullMqJobClient({ queueName: 'rhea-ai', redisUrl });
const safetyQueue = new BullMqJobClient({ queueName: 'rhea-safety', redisUrl });
const matchPool = new RedisChallengeMatchPool({ redisUrl });
let jobs = 0;
let matches = 0;
try {
  const client = await pool.connect();
  let snapshot: RuntimeRebuildSnapshot;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rhea_runtime_rebuilder');
    const result = await client.query<SnapshotRow>(
      'SELECT learning.read_runtime_rebuild_snapshot() AS snapshot',
    );
    const snapshotRow = result.rows[0];
    if (!snapshotRow) throw new Error('RUNTIME_REBUILD_SNAPSHOT_UNAVAILABLE');
    snapshot = snapshotRow.snapshot;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const row of snapshot.submissions) {
    await aiQueue.submit({
      deduplicationKey: row.id,
      kind: 'submission.recognize',
      payload: { learningProfileId: row.learningProfileId, processingJobId: row.id },
    });
    jobs += 1;
  }
  for (const row of snapshot.generatedLearning) {
    await aiQueue.submit({
      deduplicationKey: row.id,
      kind: 'generated-learning.generate',
      payload: { learningProfileId: row.learningProfileId, requestId: row.id },
    });
    jobs += 1;
  }
  for (const row of snapshot.suggestedAssessments) {
    await aiQueue.submit({
      deduplicationKey: row.id,
      kind: 'open-assessment.generate',
      payload: { learningProfileId: row.learningProfileId, suggestionId: row.id },
    });
    jobs += 1;
  }
  for (const row of snapshot.reviewCards) {
    await aiQueue.submit({
      deduplicationKey: row.id,
      kind: 'review-card.generate',
      payload: { learningProfileId: row.learningProfileId, requestId: row.id },
    });
    jobs += 1;
  }
  for (const row of snapshot.privacyTasks) {
    await safetyQueue.submit({
      deduplicationKey: row.id,
      kind: 'privacy.process',
      payload: { taskId: row.id },
    });
    jobs += 1;
  }
  await matchPool.restore(snapshot.randomMatches);
  matches = snapshot.randomMatches.length;
  console.log(JSON.stringify({ event: 'redis_authority_rebuilt', jobs, matches }));
} finally {
  await aiQueue.close();
  await safetyQueue.close();
  await matchPool.close();
  await pool.end();
}
