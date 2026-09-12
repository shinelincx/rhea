import { createPostgresReportingStore } from '@rhea/postgres-reporting';
import { MemoryReportingStore, ReportingService } from '@rhea/reporting';

export function createConfiguredReporting(environment: Record<string, string | undefined>) {
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production reporting');
    }
    return {
      service: new ReportingService({ store: new MemoryReportingStore() }),
      shutdownResources: [],
    };
  }
  const { pool, store } = createPostgresReportingStore(environment.DATABASE_URL);
  return {
    service: new ReportingService({ store }),
    shutdownResources: [{ close: () => pool.end() }],
  };
}
