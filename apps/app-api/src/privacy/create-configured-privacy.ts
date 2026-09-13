import { createPostgresPrivacyLifecycleStore } from '@rhea/postgres-privacy';
import {
  MemoryPrivacyDataPort,
  MemoryPrivacyLifecycleStore,
  PrivacyLifecycleService,
} from '@rhea/privacy-lifecycle';

export function createConfiguredPrivacy(environment: Record<string, string | undefined>) {
  const configuredPepper = environment.PRIVACY_TOMBSTONE_PEPPER;
  if (!configuredPepper && environment.NODE_ENV === 'production')
    throw new Error('PRIVACY_TOMBSTONE_PEPPER is required in production');
  const pepper = configuredPepper ?? 'local-privacy-tombstone-pepper-32-bytes';
  if (!environment.DATABASE_URL) {
    if (environment.NODE_ENV === 'production')
      throw new Error('DATABASE_URL is required for production privacy lifecycle');
    return {
      service: new PrivacyLifecycleService(
        new MemoryPrivacyLifecycleStore(),
        new MemoryPrivacyDataPort(),
        pepper,
      ),
      shutdownResources: [],
    };
  }
  const secret = environment.PRIVACY_EXPORT_ENCRYPTION_SECRET;
  if (!secret && environment.NODE_ENV === 'production')
    throw new Error('PRIVACY_EXPORT_ENCRYPTION_SECRET is required for production privacy exports');
  const configured = createPostgresPrivacyLifecycleStore(
    environment.DATABASE_URL,
    secret ?? 'local-export-encryption-secret-32-bytes',
    environment.METRICS_TOKEN_PEPPER ?? 'local-metrics-token-pepper-32-bytes',
    'rhea_privacy_api',
  );
  if (!configured.data) throw new Error('Privacy data adapter is unavailable');
  return {
    service: new PrivacyLifecycleService(configured.store, configured.data, pepper),
    shutdownResources: [{ close: () => configured.pool.end() }],
  };
}
