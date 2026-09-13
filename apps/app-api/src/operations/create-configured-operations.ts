import { createPostgresMetricsGovernanceStore } from '@rhea/postgres-metrics';
import {
  createPostgresSafetyEscalationStore,
  createSafetyStoreSecurity,
} from '@rhea/postgres-safety';
import { MetricsGovernanceService } from '@rhea/metrics-governance';
import { PostgresQualityControlStore } from '@rhea/postgres-quality-control';
import { MemoryQualityControlStore, QualityControlService } from '@rhea/quality-control';
import type { SafetyEscalationService as SafetyService } from '@rhea/safety-escalation';
import { SafetyEscalationService } from '@rhea/safety-escalation';

export function createConfiguredOperations(
  environment: Record<string, string | undefined>,
  localSafety: SafetyService,
) {
  const databaseUrl = environment.OPERATIONS_DATABASE_URL;
  const metricsPepper = environment.METRICS_TOKEN_PEPPER;
  if (!databaseUrl || !metricsPepper) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('OPERATIONS_DATABASE_URL and METRICS_TOKEN_PEPPER are required');
    }
    return {
      metrics: null,
      quality: new QualityControlService(new MemoryQualityControlStore()),
      safety: localSafety,
      shutdownResources: [],
    };
  }
  const metrics = createPostgresMetricsGovernanceStore(
    databaseUrl,
    metricsPepper,
    'rhea_metrics_operator',
  );
  const safety = createPostgresSafetyEscalationStore(
    databaseUrl,
    'rhea_safety_operator',
    createSafetyStoreSecurity(environment),
  );
  const safetyService = new SafetyEscalationService(safety.store);
  return {
    metrics: new MetricsGovernanceService(metrics.store),
    quality: new QualityControlService(new PostgresQualityControlStore(metrics.pool)),
    safety: Object.assign(safetyService, {
      resolveChallengeReportSubjects: (input: {
        occurredAt: string;
        operatorId: string;
        reason: string;
        reportId: string;
      }) => safety.store.resolveChallengeReportSubjects(input),
    }),
    shutdownResources: [{ close: () => metrics.pool.end() }, { close: () => safety.pool.end() }],
  };
}
