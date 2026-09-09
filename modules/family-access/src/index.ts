import { MemoryFamilyAccessStore } from './memory-store.js';
import { FamilyAccessService } from './service.js';
import type { Clock, IdentityProviderPort } from './types.js';

export { FamilyAccessError, type FamilyAccessErrorCode } from './error.js';
export { MemoryFamilyAccessStore } from './memory-store.js';
export { createScryptPinHasher, type PinHasher } from './pin-hasher.js';
export { FamilyAccessService, type FamilyAccessServiceDependencies } from './service.js';
export type {
  DeviceRecord,
  FamilyAccessStore,
  GuardianRecord,
  LearningProfileRecord,
  SessionRecord,
} from './store.js';
export type {
  Actor,
  Capability,
  Clock,
  FamilyAccess,
  FamilySpace,
  Grade,
  GuardianActor,
  IdentityProviderPort,
  LearnerActor,
  LearningProfile,
  RegisteredDeviceGrant,
  SessionGrant,
} from './types.js';

export function createInMemoryFamilyAccess(
  options: {
    clock?: Clock;
    identityProvider?: IdentityProviderPort;
  } = {},
) {
  const identityProvider = options.identityProvider ?? {
    async verify(identityAssertion: string) {
      return { subject: identityAssertion };
    },
  };
  return new FamilyAccessService({
    ...(options.clock ? { clock: options.clock } : {}),
    identityProvider,
    store: new MemoryFamilyAccessStore(),
  });
}
