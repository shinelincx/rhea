import {
  createPostgresSafetyEscalationStore,
  createSafetyStoreSecurity,
} from '@rhea/postgres-safety';
import { MemorySafetyEscalationStore, SafetyEscalationService } from '@rhea/safety-escalation';

export function createWorkerSafetyEscalation(
  environment: Record<string, string | undefined>,
  role: 'classifier' | 'disabled' | 'worker',
): {
  processChallengeReportClassifications(): Promise<{
    claimed: number;
    failed: number;
    processed: number;
  }>;
  service: SafetyEscalationService;
  shutdownResources: Array<{ close(): Promise<void> }>;
} {
  if (role === 'disabled' || !environment.DATABASE_URL) {
    return {
      processChallengeReportClassifications: async () => ({ claimed: 0, failed: 0, processed: 0 }),
      service: new SafetyEscalationService(new MemorySafetyEscalationStore()),
      shutdownResources: [],
    };
  }
  const configured = createPostgresSafetyEscalationStore(
    environment.DATABASE_URL,
    role === 'classifier' ? 'rhea_safety_classifier' : 'rhea_safety_worker',
    createSafetyStoreSecurity(environment),
  );
  return {
    processChallengeReportClassifications: async () => {
      await configured.store.purgeExpiredChallengeReportSubjectMappings();
      return configured.store.processChallengeReportClassifications();
    },
    service: new SafetyEscalationService(configured.store),
    shutdownResources: [{ close: () => configured.pool.end() }],
  };
}
