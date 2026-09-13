import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { createS3ObjectStore } from '../../../adapters/object-storage/dist/index.js';
import { ShanghaiKmsProfileKeyWrapper } from '../../../adapters/postgres-privacy/dist/index.js';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
};
const requireTlsDatabaseUrl = (name) => {
  const value = required(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(name + ' must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error(name + ' must use PostgreSQL sslmode=verify-full');
  }
  return value;
};
const requireTlsRedisUrl = (name) => {
  const value = required(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(name + ' must be a valid Redis URL');
  }
  if (url.protocol !== 'rediss:') throw new Error(name + ' must use rediss://');
  return value;
};
const startedAt = new Date(required('DRILL_STARTED_AT'));
const restoreLagMinutes = Number(required('RESTORE_POINT_LAG_MINUTES'));
if (
  Number.isNaN(startedAt.getTime()) ||
  startedAt.getTime() > Date.now() ||
  !Number.isFinite(restoreLagMinutes) ||
  restoreLagMinutes < 0
) {
  throw new Error('Recovery drill timing inputs are invalid');
}
const databaseUrl = requireTlsDatabaseUrl('DRILL_RESTORED_DATABASE_URL');
const redisUrl = requireTlsRedisUrl('DRILL_REDIS_URL');
const pepper = required('PRIVACY_TOMBSTONE_PEPPER');
const metricsPepper = required('METRICS_TOKEN_PEPPER');
const kmsKeyId = required('DRILL_KMS_KEY_ID');
const evidencePath = process.env.DRILL_EVIDENCE_PATH ?? './recovery-drill-evidence.json';
const pool = new Pool({ connectionString: databaseUrl });
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
const ledger = createS3ObjectStore({
  accessKeyId: required('ERASURE_LEDGER_READ_ACCESS_KEY'),
  bucket: required('ERASURE_LEDGER_BUCKET'),
  endpoint: required('OBJECT_STORE_ENDPOINT'),
  forcePathStyle: process.env.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
  region: required('OBJECT_STORE_REGION'),
  secretAccessKey: required('ERASURE_LEDGER_READ_SECRET_KEY'),
});
const checks = [];
const execFileAsync = promisify(execFile);
let deletedRestoredProfiles = 0;
try {
  const isolationClient = await pool.connect();
  try {
    await isolationClient.query('BEGIN');
    await isolationClient.query('SET LOCAL ROLE rhea_runtime_rebuilder');
    const permissions = await isolationClient.query(`SELECT
      has_table_privilege(current_user,'learning.learning_profiles','SELECT') AS learning_table,
      has_table_privilege(current_user,'safety.cases','SELECT') AS safety_table,
      has_table_privilege(current_user,'metrics.learning_events','SELECT') AS metrics_table`);
    checks.push({
      check: 'runtime_rebuilder_has_no_direct_table_access',
      passed: Object.values(permissions.rows[0] ?? {}).every((value) => value === false),
    });
    await isolationClient.query('COMMIT');
  } catch (error) {
    await isolationClient.query('ROLLBACK');
    throw error;
  } finally {
    isolationClient.release();
  }
  const kms = new ShanghaiKmsProfileKeyWrapper({
    credentialsFile: required('WORKLOAD_CREDENTIALS_FILE'),
    ...(process.env.KMS_ENDPOINT ? { endpoint: process.env.KMS_ENDPOINT } : {}),
    expectedRoleArn: required('WORKLOAD_ROLE_ARN'),
    regionId: 'cn-shanghai',
  });
  const probePlaintext = randomBytes(32);
  const probeScope = {
    familySpaceId: '00000000-0000-4000-8000-0000000000d1',
    kmsKeyId,
    learningProfileId: '00000000-0000-4000-8000-0000000000d2',
  };
  const probeCiphertext = await kms.wrap({ ...probeScope, plaintextKey: probePlaintext });
  const probeResult = Buffer.from(await kms.unwrap({ ...probeScope, wrappedKey: probeCiphertext }));
  checks.push({
    check: 'key_management_decrypt_probe',
    keyId: kmsKeyId,
    passed:
      probeResult.byteLength === probePlaintext.byteLength &&
      timingSafeEqual(probeResult, probePlaintext),
  });
  const ledgerEntries = await ledger.store.listPrefix('erasure-ledger/');
  const tokens = new Set();
  for (const entry of ledgerEntries) {
    const tombstone = JSON.parse(Buffer.from(entry.bytes).toString('utf8'));
    if (
      !tombstone ||
      typeof tombstone.subjectToken !== 'string' ||
      !/^[0-9a-f]{64}$/.test(tombstone.subjectToken)
    ) {
      throw new Error(`Invalid erasure ledger entry: ${entry.key}`);
    }
    tokens.add(tombstone.subjectToken);
  }
  checks.push({ check: 'independent_erasure_ledger_loaded', entries: tokens.size, passed: true });
  const recoveryClient = await pool.connect();
  let profiles;
  try {
    await recoveryClient.query('BEGIN');
    await recoveryClient.query('SET LOCAL ROLE rhea_runtime_rebuilder');
    profiles = await recoveryClient.query(
      'SELECT family_space_id,learning_profile_id FROM learning.read_recovery_profiles()',
    );
    await recoveryClient.query('COMMIT');
  } catch (error) {
    await recoveryClient.query('ROLLBACK');
    throw error;
  } finally {
    recoveryClient.release();
  }
  for (const profile of profiles.rows) {
    const token = createHmac('sha256', pepper).update(profile.learning_profile_id).digest('hex');
    if (!tokens.has(token)) continue;
    const metricsFamilyToken = createHmac('sha256', metricsPepper)
      .update(profile.family_space_id)
      .digest('hex');
    const metricsProfileToken = createHmac('sha256', metricsPepper)
      .update(profile.learning_profile_id)
      .digest('hex');
    const replayClient = await pool.connect();
    let replay;
    try {
      await replayClient.query('BEGIN');
      await replayClient.query('SET LOCAL ROLE rhea_runtime_rebuilder');
      replay = await replayClient.query(
        'SELECT learning.replay_restored_profile_erasure($1,$2,$3,$4,$5) AS result',
        [
          profile.family_space_id,
          profile.learning_profile_id,
          token,
          metricsFamilyToken,
          metricsProfileToken,
        ],
      );
      await replayClient.query('COMMIT');
    } catch (error) {
      await replayClient.query('ROLLBACK');
      throw error;
    } finally {
      replayClient.release();
    }
    const result = replay.rows[0]?.result;
    if (!result?.deleted || !result?.keyWrapDestroyed) {
      throw new Error(`Erasure replay was not verified for ${profile.learning_profile_id}`);
    }
    deletedRestoredProfiles += 1;
  }
  const verifyClient = await pool.connect();
  let remainingProfiles;
  try {
    await verifyClient.query('BEGIN');
    await verifyClient.query('SET LOCAL ROLE rhea_runtime_rebuilder');
    remainingProfiles = await verifyClient.query(
      'SELECT learning_profile_id FROM learning.read_recovery_profiles()',
    );
    await verifyClient.query('COMMIT');
  } catch (error) {
    await verifyClient.query('ROLLBACK');
    throw error;
  } finally {
    verifyClient.release();
  }
  const resurrectedProfiles = remainingProfiles.rows.filter(({ learning_profile_id }) =>
    tokens.has(createHmac('sha256', pepper).update(learning_profile_id).digest('hex')),
  ).length;
  checks.push({
    check: 'erasure_tombstones_replayed',
    deletedRestoredProfiles,
    passed: resurrectedProfiles === 0,
    resurrectedProfiles,
  });
  const redisPing = await redis.ping();
  checks.push({ check: 'redis_ready_for_authority_rebuild', passed: redisPing === 'PONG' });
  try {
    await execFileAsync('node', ['apps/job-worker/dist/rebuild-runtime.js'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl },
      timeout: 15 * 60_000,
    });
    checks.push({ check: 'redis_authority_rebuilt', passed: true });
  } catch {
    checks.push({ check: 'redis_authority_rebuilt', passed: false });
  }
  checks.push({
    check: 'rpo_within_15_minutes',
    passed: restoreLagMinutes <= 15,
    valueMinutes: restoreLagMinutes,
  });
  const rtoMinutes = (Date.now() - startedAt.getTime()) / 60000;
  checks.push({ check: 'rto_within_4_hours', passed: rtoMinutes <= 240, valueMinutes: rtoMinutes });
  const evidence = {
    drillVersion: 'rhea-quarterly-recovery-v1',
    finishedAt: new Date().toISOString(),
    passed: checks.every(({ passed }) => passed),
    checks,
    nextRequiredBy: new Date(Date.now() + 90 * 86400000).toISOString(),
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ event: 'recovery_drill_complete', evidencePath, passed: evidence.passed }),
  );
  if (!evidence.passed) process.exitCode = 1;
} finally {
  ledger.client.destroy();
  await redis.quit();
  await pool.end();
}
