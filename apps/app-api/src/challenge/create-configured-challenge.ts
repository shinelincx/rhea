import {
  ChallengeService,
  MemoryChallengeMatchPool,
  type ChallengeAuthorizationPort,
} from '@rhea/challenge';
import { createPostgresChallengeStore } from '@rhea/postgres-challenge';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';
import { RedisChallengeMatchPool } from '@rhea/redis-challenge-match';

import { createLocalChallenge } from './create-local-challenge.js';
import { createDeterministicChallengePackFactory } from './deterministic-pack-factory.js';

export function createConfiguredChallenge(
  environment: Record<string, string | undefined>,
  authorization: ChallengeAuthorizationPort,
) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production challenge');
    }
    return { service: createLocalChallenge(authorization), shutdownResources: [] };
  }
  const pepper =
    environment.CHALLENGE_INVITE_PEPPER ??
    (environment.NODE_ENV === 'production' ? undefined : 'local-development-challenge-pepper');
  if (!pepper || pepper.length < 24) {
    throw new Error('CHALLENGE_INVITE_PEPPER must be configured with at least 24 characters');
  }
  const avoidancePepper =
    environment.CHALLENGE_PAIR_AVOIDANCE_PEPPER ??
    (environment.NODE_ENV === 'production' ? undefined : 'local-development-avoidance-pepper');
  if (!avoidancePepper || avoidancePepper.length < 24) {
    throw new Error(
      'CHALLENGE_PAIR_AVOIDANCE_PEPPER must be configured with at least 24 characters',
    );
  }
  if (environment.NODE_ENV === 'production' && !environment.REDIS_URL) {
    throw new Error('REDIS_URL is required for production random challenge matching');
  }
  const { pool, store } = createPostgresChallengeStore(environment.DATABASE_URL);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(pool as never));
  const matchPool = environment.REDIS_URL
    ? new RedisChallengeMatchPool({ redisUrl: environment.REDIS_URL })
    : new MemoryChallengeMatchPool();
  const service = new ChallengeService({
    authorization,
    invitationPepper: pepper,
    matchPool,
    packFactory: createDeterministicChallengePackFactory(qualityControl),
    pairAvoidancePepper: avoidancePepper,
    store,
  });
  const expirySweep = setInterval(() => {
    void service.expireDueRandomChallenges().catch((error: unknown) => {
      console.error('Random challenge expiry sweep failed', error);
    });
  }, 60_000);
  expirySweep.unref();
  return {
    service,
    shutdownResources: [
      { close: async () => clearInterval(expirySweep) },
      ...(matchPool instanceof RedisChallengeMatchPool ? [{ close: () => matchPool.close() }] : []),
      { close: () => pool.end() },
    ],
  };
}
