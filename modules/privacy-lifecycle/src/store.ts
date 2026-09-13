import type { ErasureCertificate, ErasureTombstone, PrivacyTask } from './types.js';

export interface PrivacyLifecycleStore {
  completeErasure(
    task: PrivacyTask,
    certificate: ErasureCertificate,
    tombstone: ErasureTombstone,
  ): Promise<void>;
  createTask(task: PrivacyTask): Promise<PrivacyTask>;
  findTask(taskId: string, scope?: { familySpaceId: string }): Promise<PrivacyTask | null>;
  findCertificate(
    taskId: string,
    scope?: { familySpaceId: string },
  ): Promise<ErasureCertificate | null>;
  listTombstones(): Promise<ErasureTombstone[]>;
  updateTask(task: PrivacyTask): Promise<void>;
}
