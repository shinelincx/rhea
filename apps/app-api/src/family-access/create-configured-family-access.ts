import {
  FamilyAccessService,
  createInMemoryFamilyAccess,
  type AiProcessingConsentPublicationReader,
  type ChallengeAuthorizationPublicationReader,
  type FamilyAccess,
  type IdentityProviderPort,
} from '@rhea/family-access';
import { createPostgresFamilyAccessStore } from '@rhea/postgres-family-access';
import { GovernedHttpClient, ShanghaiCiamIdentityProvider } from '@rhea/china-provider-adapters';
import type { ProviderGovernanceService } from '@rhea/provider-governance';

export interface ConfiguredFamilyAccess {
  familyAccess: AiProcessingConsentPublicationReader &
    ChallengeAuthorizationPublicationReader &
    FamilyAccess;
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
  governance?: ProviderGovernanceService,
): ConfiguredFamilyAccess {
  const identityProvider =
    environment.NODE_ENV === 'production'
      ? new ShanghaiCiamIdentityProvider(
          new GovernedHttpClient({
            authorizationToken: environment.CIAM_TOKEN ?? '',
            capabilityVersionId: environment.CIAM_CAPABILITY_VERSION_ID ?? '',
            dataCategories: ['authentication_assertion'],
            governance:
              governance ??
              (() => {
                throw new Error('Provider governance is required');
              })(),
            purpose: 'guardian_authentication',
            url: environment.CIAM_URL ?? '',
          }),
        )
      : developmentIdentityProvider(environment);
  if (
    environment.NODE_ENV === 'production' &&
    (!environment.CIAM_URL || !environment.CIAM_TOKEN || !environment.CIAM_CAPABILITY_VERSION_ID)
  ) {
    throw new Error(
      'CIAM_URL, CIAM_TOKEN and CIAM_CAPABILITY_VERSION_ID are required for production',
    );
  }
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
