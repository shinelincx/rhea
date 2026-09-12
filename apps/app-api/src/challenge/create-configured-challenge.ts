import { ChallengeService, type ChallengeAuthorizationPort } from '@rhea/challenge';
import { createPostgresChallengeStore } from '@rhea/postgres-challenge';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { QualityControlService } from '@rhea/quality-control';

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
  const { pool, store } = createPostgresChallengeStore(environment.DATABASE_URL);
  const qualityControl = new QualityControlService(new PostgresQualityControlStore(pool as never));
  return {
    service: new ChallengeService({
      authorization,
      invitationPepper: pepper,
      packFactory: createDeterministicChallengePackFactory(qualityControl),
      store,
    }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
