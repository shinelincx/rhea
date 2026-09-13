import { createPostgresProviderGovernanceStore } from '@rhea/postgres-provider-governance';
import {
  MemoryProviderGovernanceStore,
  ProviderGovernanceService,
} from '@rhea/provider-governance';
export function createConfiguredProviderGovernance(
  environment: Record<string, string | undefined>,
) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production')
      throw new Error('DATABASE_URL is required for production provider governance');
    return {
      service: new ProviderGovernanceService(new MemoryProviderGovernanceStore()),
      shutdownResources: [],
    };
  }
  const configured = createPostgresProviderGovernanceStore(environment.DATABASE_URL);
  return {
    service: new ProviderGovernanceService(configured.store),
    shutdownResources: [{ close: () => configured.pool.end() }],
  };
}
