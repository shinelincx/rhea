import {
  ChallengeService,
  MemoryChallengeMatchPool,
  MemoryChallengeStore,
  type ChallengeAuthorizationPort,
} from '@rhea/challenge';
import type { CapabilityVersion } from '@rhea/quality-control';

import { createLocalCapabilityAuthorization } from '../quality-control/local-capability-authorization.js';
import { createDeterministicChallengePackFactory } from './deterministic-pack-factory.js';

const LOCAL_CHALLENGE_CAPABILITY: CapabilityVersion = {
  adapter: { id: 'deterministic-challenge-pack', version: '1' },
  artifactHash: 'c'.repeat(64),
  capabilityKey: 'ai.challenge-pack',
  id: 'local-rules-challenge-pack-v1',
  implementedBy: 'app-api-local',
  kind: 'ai',
  modelOrEngine: { id: 'deterministic-objective-pack', version: '1' },
  policyVersion: 'child-challenge-v1',
  promptOrConfig: { kind: 'config', version: '1' },
  provider: { id: 'rhea', version: '1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-12T00:00:00.000Z',
  requiredSlicePolicyVersion: 'local-development-only',
  templateVersion: '1',
};

export function createLocalChallenge(authorization: ChallengeAuthorizationPort) {
  const capabilityAuthority = createLocalCapabilityAuthorization(LOCAL_CHALLENGE_CAPABILITY);
  return new ChallengeService({
    authorization,
    invitationPepper: 'local-development-challenge-pepper',
    matchPool: new MemoryChallengeMatchPool(),
    packFactory: createDeterministicChallengePackFactory(capabilityAuthority),
    pairAvoidancePepper: 'local-development-avoidance-pepper',
    store: new MemoryChallengeStore(),
  });
}
