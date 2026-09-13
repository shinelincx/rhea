import type { PrivacyDataPort } from './ports.js';
import type { PrivacyLifecycleStore } from './store.js';
import type {
  ErasureCertificate,
  ErasureTarget,
  ErasureTombstone,
  PrivacyScope,
  PrivacyTask,
} from './types.js';

export class MemoryPrivacyLifecycleStore implements PrivacyLifecycleStore {
  readonly tasks = new Map<string, PrivacyTask>();
  readonly tombstones: ErasureTombstone[] = [];
  readonly certificates = new Map<string, ErasureCertificate>();
  async createTask(task: PrivacyTask) {
    if (task.kind === 'erasure') {
      const existing = [...this.tasks.values()].find(
        (candidate) =>
          candidate.kind === 'erasure' &&
          candidate.familySpaceId === task.familySpaceId &&
          candidate.learningProfileId === task.learningProfileId &&
          !['completed', 'failed'].includes(candidate.status),
      );
      if (existing) return structuredClone(existing);
    }
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }
  async findTask(taskId: string) {
    return structuredClone(this.tasks.get(taskId) ?? null);
  }
  async findCertificate(taskId: string) {
    return structuredClone(this.certificates.get(taskId) ?? null);
  }
  async listTombstones() {
    return structuredClone(this.tombstones);
  }
  async completeErasure(
    task: PrivacyTask,
    certificate: ErasureCertificate,
    tombstone: ErasureTombstone,
  ) {
    this.certificates.set(certificate.id, structuredClone(certificate));
    const existingIndex = this.tombstones.findIndex(
      (candidate) => candidate.subjectToken === tombstone.subjectToken,
    );
    if (existingIndex >= 0) this.tombstones[existingIndex] = structuredClone(tombstone);
    else this.tombstones.push(structuredClone(tombstone));
    this.tasks.set(task.id, structuredClone(task));
  }
  async updateTask(task: PrivacyTask) {
    this.tasks.set(task.id, structuredClone(task));
  }
}

export class MemoryPrivacyDataPort implements PrivacyDataPort {
  readonly archivedTombstones: ErasureTombstone[] = [];
  readonly deleted: Array<PrivacyScope & { target: ErasureTarget }> = [];
  readonly frozen: PrivacyScope[] = [];
  async archiveTombstone(tombstone: ErasureTombstone) {
    const index = this.archivedTombstones.findIndex(
      (candidate) => candidate.subjectToken === tombstone.subjectToken,
    );
    if (index >= 0) this.archivedTombstones[index] = structuredClone(tombstone);
    else this.archivedTombstones.push(structuredClone(tombstone));
  }
  async deleteTarget(input: PrivacyScope & { target: ErasureTarget }) {
    this.deleted.push(structuredClone(input));
    return { receipt: `${input.target}:deleted` };
  }
  async exportProfile(input: PrivacyScope & { taskId: string }) {
    return {
      contentTypes: [
        'profile',
        'learning_content',
        'assessments',
        'wrong_items',
        'review_cards',
        'challenges',
        'growth',
        'source_history',
        'state_history',
      ],
      generatedAt: new Date().toISOString(),
      objectKey: `exports/${input.taskId}.json.enc`,
      sourceHistoryIncluded: true as const,
      stateHistoryIncluded: true as const,
    };
  }
  async downloadExport(input: PrivacyScope & { taskId: string }) {
    return {
      fileName: `rhea-profile-${input.learningProfileId}.json`,
      generatedAt: new Date().toISOString(),
      payload: { familySpaceId: input.familySpaceId, learningProfileId: input.learningProfileId },
    };
  }
  async freezeProfile(input: PrivacyScope) {
    if (
      !this.frozen.some(
        (item) =>
          item.familySpaceId === input.familySpaceId &&
          item.learningProfileId === input.learningProfileId,
      )
    )
      this.frozen.push(structuredClone(input));
  }
  async profileExists(_input: PrivacyScope) {
    return true;
  }
  async purgeExpiredExports() {
    return 0;
  }
}
