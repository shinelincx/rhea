import type { PrivacyLifecycleService } from '@rhea/privacy-lifecycle';
export const PRIVACY_LIFECYCLE_SERVICE = Symbol('PRIVACY_LIFECYCLE_SERVICE');
export const PRIVACY_TASK_SCHEDULER = Symbol('PRIVACY_TASK_SCHEDULER');
export interface PrivacyTaskScheduler {
  schedule(taskId: string): Promise<void>;
}
export type { PrivacyLifecycleService };
