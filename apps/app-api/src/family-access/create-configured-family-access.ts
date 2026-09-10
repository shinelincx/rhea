import {
  FamilyAccessService,
  createInMemoryFamilyAccess,
  type AiProcessingConsentPublicationReader,
  type FamilyAccess,
  type IdentityProviderPort,
} from '@rhea/family-access';
import { createPostgresFamilyAccessStore } from '@rhea/postgres-family-access';

export interface ConfiguredFamilyAccess {
  familyAccess: AiProcessingConsentPublicationReader & FamilyAccess;
  shutdownResources: Array<{ close(): Promise<void> }>;
}

function developmentIdentityProvider(
  environment: Record<string, string | undefined>,
): IdentityProviderPort {
  return {
    async verify(identityAssertion) {
      if (
        environment.IDENTITY_PROVIDER_MODE !== 'development' ||
        !identityAssertion.startsWith('development:')
      ) {
        throw new Error('identity assertion rejected');
      }
      return { subject: identityAssertion };
    },
  };
}

export function createConfiguredFamilyAccess(
  environment: Record<string, string | undefined>,
): ConfiguredFamilyAccess {
  const identityProvider = developmentIdentityProvider(environment);
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    return {
      familyAccess: createInMemoryFamilyAccess({ identityProvider }),
      shutdownResources: [],
    };
  }

  const { pool, store } = createPostgresFamilyAccessStore(databaseUrl);
  return {
    familyAccess: new FamilyAccessService({ identityProvider, store }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
