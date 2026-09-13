import {
  createPostgresSafetyEscalationStore,
  createSafetyStoreSecurity,
} from '@rhea/postgres-safety';
import { MemorySafetyEscalationStore, SafetyEscalationService } from '@rhea/safety-escalation';

export function createConfiguredSafety(environment: Record<string, string | undefined>) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production')
      throw new Error('DATABASE_URL is required for production safety escalation');
    return {
      service: new SafetyEscalationService(new MemorySafetyEscalationStore()),
      shutdownResources: [],
    };
  }
  const { pool, store } = createPostgresSafetyEscalationStore(
    environment.DATABASE_URL,
    'rhea_safety_api',
    createSafetyStoreSecurity(environment),
  );
  return {
    service: new SafetyEscalationService(store),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
