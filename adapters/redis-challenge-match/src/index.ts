import type {
  ChallengeMatchPoolEntry,
  ChallengeMatchPoolOutcome,
  ChallengeMatchPoolPort,
} from '@rhea/challenge';
import { Redis } from 'ioredis';

const ENTER_SCRIPT = `
local bucket = KEYS[1]
local records = KEYS[2]
local entry_id = ARGV[1]
local profile_id = ARGV[2]
local payload = ARGV[3]
local now_ms = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])

local own_previous = redis.call('HGET', records, 'profile:' .. profile_id)
if own_previous then
  redis.call('SREM', bucket, own_previous)
  redis.call('HDEL', records, 'entry:' .. own_previous)
end

local attempts = math.min(tonumber(redis.call('SCARD', bucket)), 100)
for _ = 1, attempts do
  local candidate_id = redis.call('SRANDMEMBER', bucket)
  if not candidate_id then break end
  local candidate_payload = redis.call('HGET', records, 'entry:' .. candidate_id)
  if not candidate_payload then
    redis.call('SREM', bucket, candidate_id)
  else
    local candidate = cjson.decode(candidate_payload)
    if tonumber(candidate.expiresAtMs) <= now_ms
       or candidate.entry.actor.learningProfileId == profile_id then
      redis.call('SREM', bucket, candidate_id)
      redis.call('HDEL', records, 'entry:' .. candidate_id)
      redis.call('HDEL', records, 'profile:' .. candidate.entry.actor.learningProfileId)
    else
      redis.call('SREM', bucket, candidate_id)
      redis.call('HDEL', records, 'entry:' .. candidate_id)
      redis.call('HDEL', records, 'profile:' .. candidate.entry.actor.learningProfileId)
      return candidate_payload
    end
  end
end

redis.call('SADD', bucket, entry_id)
redis.call('HSET', records, 'entry:' .. entry_id, payload)
redis.call('HSET', records, 'profile:' .. profile_id, entry_id)
redis.call('PEXPIRE', bucket, ttl_ms)
redis.call('PEXPIRE', records, ttl_ms)
return ''
`;

const RESTORE_SCRIPT = `
local bucket = KEYS[1]
local records = KEYS[2]
local entry_id = ARGV[1]
local profile_id = ARGV[2]
local payload = ARGV[3]
local ttl_ms = tonumber(ARGV[4])
local previous = redis.call('HGET', records, 'profile:' .. profile_id)
if previous then redis.call('SREM', bucket, previous) end
redis.call('SADD', bucket, entry_id)
redis.call('HSET', records, 'entry:' .. entry_id, payload)
redis.call('HSET', records, 'profile:' .. profile_id, entry_id)
redis.call('PEXPIRE', bucket, ttl_ms)
redis.call('PEXPIRE', records, ttl_ms)
return 1
`;

const REMOVE_SCRIPT = `
local bucket = KEYS[1]
local records = KEYS[2]
local entry_id = ARGV[1]
local profile_id = ARGV[2]
local current = redis.call('HGET', records, 'profile:' .. profile_id)
if current == entry_id then redis.call('HDEL', records, 'profile:' .. profile_id) end
redis.call('SREM', bucket, entry_id)
redis.call('HDEL', records, 'entry:' .. entry_id)
return 1
`;

export interface RedisChallengeMatchPoolOptions {
  keyPrefix?: string;
  redisUrl: string;
}

function encoded(entry: ChallengeMatchPoolEntry): string {
  return JSON.stringify({ entry, expiresAtMs: Date.parse(entry.expiresAt) });
}

function decoded(value: unknown): ChallengeMatchPoolEntry {
  if (typeof value !== 'string') throw new Error('INVALID_MATCH_POOL_RESULT');
  const parsed = JSON.parse(value) as { entry?: ChallengeMatchPoolEntry };
  if (!parsed.entry) throw new Error('INVALID_MATCH_POOL_RESULT');
  return parsed.entry;
}

export class RedisChallengeMatchPool implements ChallengeMatchPoolPort {
  readonly #keyPrefix: string;
  readonly #redis: Redis;

  constructor(options: RedisChallengeMatchPoolOptions) {
    this.#keyPrefix = options.keyPrefix ?? 'rhea:challenge';
    this.#redis = new Redis(options.redisUrl, { maxRetriesPerRequest: 2 });
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  async enter(entry: ChallengeMatchPoolEntry): Promise<ChallengeMatchPoolOutcome> {
    const ttlMs = Math.max(Date.parse(entry.expiresAt) - Date.now(), 1);
    const result = await this.#redis.eval(
      ENTER_SCRIPT,
      2,
      this.#bucket(entry.grade),
      this.#records(entry.grade),
      entry.entryId,
      entry.actor.learningProfileId,
      encoded(entry),
      String(Date.now()),
      String(ttlMs),
    );
    return result === '' ? { kind: 'waiting' } : { kind: 'candidate', opponent: decoded(result) };
  }

  async remove(entry: ChallengeMatchPoolEntry): Promise<void> {
    await this.#redis.eval(
      REMOVE_SCRIPT,
      2,
      this.#bucket(entry.grade),
      this.#records(entry.grade),
      entry.entryId,
      entry.actor.learningProfileId,
    );
  }

  async restore(entries: ChallengeMatchPoolEntry[]): Promise<void> {
    for (const entry of entries) {
      const ttlMs = Math.max(Date.parse(entry.expiresAt) - Date.now(), 1);
      await this.#redis.eval(
        RESTORE_SCRIPT,
        2,
        this.#bucket(entry.grade),
        this.#records(entry.grade),
        entry.entryId,
        entry.actor.learningProfileId,
        encoded(entry),
        String(ttlMs),
      );
    }
  }

  #bucket(grade: number): string {
    return `${this.#keyPrefix}:{grade:${grade}}:waiting`;
  }

  #records(grade: number): string {
    return `${this.#keyPrefix}:{grade:${grade}}:records`;
  }
}
