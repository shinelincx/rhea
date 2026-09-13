import { createHmac, randomUUID } from 'node:crypto';

import { PrivacyLifecycleError } from './error.js';
import type { PrivacyDataPort } from './ports.js';
import type { PrivacyLifecycleStore } from './store.js';
import type {
  ErasureCertificate,
  ErasurePreview,
  ErasureTarget,
  PrivacyScope,
  PrivacyTask,
} from './types.js';

const TARGETS: ErasureTarget[] = [
  'cache',
  'vendor_copies',
  'object_storage',
  'key_wrap',
  'active_database',
];
const DAY = 86_400_000;
function required(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 200) {
    throw new PrivacyLifecycleError('PRIVACY_INPUT_INVALID', `${label}无效`);
  }
  return result;
}

export class PrivacyLifecycleService {
  readonly #clock: { readonly now: Date };
  constructor(
    readonly store: PrivacyLifecycleStore,
    readonly data: PrivacyDataPort,
    readonly tombstonePepper: string,
    clock?: { readonly now: Date },
  ) {
    if (tombstonePepper.length < 24) throw new Error('删除墓碑密钥至少需要 24 个字符');
    this.#clock = clock ?? {
      get now() {
        return new Date();
      },
    };
  }

  previewErasure(input: PrivacyScope): ErasurePreview {
    const scope = this.#scope(input);
    return {
      ...scope,
      confirmationText: `删除学习档案 ${scope.learningProfileId}`,
      deadlineDays: 30,
      effects: [
        '立即撤销学习会话、挑战和新的 AI/OCR 处理',
        '删除学习记录、文件、缓存和已确认供应商副本',
        '销毁此档案的密钥包装，使残留密文不可读取',
        '保留不含学习内容的删除证明与备份墓碑',
      ],
      targets: [...TARGETS],
    };
  }

  async requestExport(
    input: PrivacyScope & { requestedByGuardianId: string },
  ): Promise<PrivacyTask> {
    if (!(await this.data.profileExists(this.#scope(input)))) {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_FOUND', '学习档案不属于当前家庭空间');
    }
    return this.#createTask('export', input);
  }

  async requestErasure(
    input: PrivacyScope & { confirmationText: string; requestedByGuardianId: string },
  ): Promise<PrivacyTask> {
    const preview = this.previewErasure(input);
    if (input.confirmationText !== preview.confirmationText) {
      throw new PrivacyLifecycleError('PRIVACY_INPUT_INVALID', '删除确认文字不匹配');
    }
    const scope = this.#scope(input);
    if (!(await this.data.profileExists(scope))) {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_FOUND', '学习档案不属于当前家庭空间');
    }
    const task = await this.#createTask('erasure', input);
    await this.data.freezeProfile(scope);
    return task;
  }

  async getTask(taskId: string, scope?: { familySpaceId: string }): Promise<PrivacyTask> {
    const task = await this.store.findTask(required(taskId, '隐私任务'), scope);
    if (!task) throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_FOUND', '隐私任务不存在');
    return task;
  }

  async getErasureCertificate(input: PrivacyScope & { taskId: string }) {
    const scope = this.#scope(input);
    const task = await this.getTask(input.taskId, { familySpaceId: scope.familySpaceId });
    if (
      task.familySpaceId !== scope.familySpaceId ||
      task.learningProfileId !== scope.learningProfileId ||
      task.kind !== 'erasure'
    ) {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_FOUND', '删除任务不存在');
    }
    if (task.status !== 'completed') {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_READY', '删除任务尚未完成');
    }
    const certificate = await this.store.findCertificate(task.id, {
      familySpaceId: scope.familySpaceId,
    });
    if (!certificate) {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_READY', '删除证明尚未生成');
    }
    return certificate;
  }

  async downloadExport(input: PrivacyScope & { taskId: string }) {
    const scope = this.#scope(input);
    const task = await this.getTask(input.taskId, { familySpaceId: scope.familySpaceId });
    if (
      task.familySpaceId !== scope.familySpaceId ||
      task.learningProfileId !== scope.learningProfileId ||
      task.kind !== 'export'
    ) {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_FOUND', '导出任务不存在');
    }
    if (
      task.status !== 'completed' ||
      !task.download ||
      Date.parse(task.download.expiresAt) <= this.#clock.now.getTime()
    ) {
      throw new PrivacyLifecycleError('PRIVACY_TASK_NOT_READY', '导出尚未完成或下载已经过期');
    }
    return this.data.downloadExport({ ...scope, taskId: task.id });
  }

  async processTask(taskId: string): Promise<PrivacyTask> {
    const task = await this.getTask(taskId);
    if (task.status === 'completed') return task;
    if (Date.parse(task.deadlineAt) <= this.#clock.now.getTime()) {
      const failed: PrivacyTask = {
        ...task,
        errorCode: 'DEADLINE_EXCEEDED',
        status: 'failed',
        updatedAt: this.#clock.now.toISOString(),
      };
      await this.store.updateTask(failed);
      return failed;
    }
    const processing: PrivacyTask = {
      ...task,
      attempts: task.attempts + 1,
      errorCode: null,
      status: 'processing',
      updatedAt: this.#clock.now.toISOString(),
    };
    await this.store.updateTask(processing);
    let latestReceipts = { ...processing.targetReceipts };
    try {
      if (task.kind === 'export') {
        const bundle = await this.data.exportProfile({ ...this.#scope(task), taskId: task.id });
        const completed = {
          ...processing,
          completedAt: this.#clock.now.toISOString(),
          download: {
            expiresAt: new Date(this.#clock.now.getTime() + DAY).toISOString(),
            objectKey: bundle.objectKey,
          },
          status: 'completed' as const,
          updatedAt: this.#clock.now.toISOString(),
        };
        await this.store.updateTask(completed);
        return completed;
      }
      await this.data.freezeProfile(this.#scope(task));
      for (const target of TARGETS) {
        if (latestReceipts[target]) continue;
        latestReceipts[target] = (
          await this.data.deleteTarget({ ...this.#scope(task), target })
        ).receipt;
        await this.store.updateTask({
          ...processing,
          targetReceipts: { ...latestReceipts },
          updatedAt: this.#clock.now.toISOString(),
        });
      }
      const completedAt = this.#clock.now.toISOString();
      const certificate: ErasureCertificate = {
        completedAt,
        id: task.id,
        statement:
          'Rhea 已完成此任务登记的在线数据、对象、供应商副本、缓存和密钥包装删除；证明不包含已删除内容。',
        targetNames: [...TARGETS],
        taskId: task.id,
      };
      const tombstone = {
        completedAt,
        completionCertificateId: certificate.id,
        createdAt: completedAt,
        subjectToken: this.#subjectToken(task.learningProfileId),
        taskId: task.id,
        targetNames: [...TARGETS],
      } satisfies import('./types.js').ErasureTombstone;
      const completed = {
        ...processing,
        completedAt,
        status: 'completed' as const,
        targetReceipts: latestReceipts,
        updatedAt: completedAt,
      };
      await this.data.archiveTombstone(tombstone);
      await this.store.completeErasure(completed, certificate, tombstone);
      return completed;
    } catch {
      const failed = {
        ...processing,
        errorCode: 'TARGET_RETRY_REQUIRED',
        status: 'retry_scheduled' as const,
        targetReceipts: latestReceipts,
        updatedAt: this.#clock.now.toISOString(),
      };
      await this.store.updateTask(failed);
      return failed;
    }
  }

  async replayTombstones(restoredProfiles: PrivacyScope[]): Promise<PrivacyScope[]> {
    const tombstones = await this.store.listTombstones();
    const tokens = new Set(tombstones.map((item) => item.subjectToken));
    const deleted: PrivacyScope[] = [];
    for (const profile of restoredProfiles) {
      if (!tokens.has(this.#subjectToken(profile.learningProfileId))) continue;
      await this.data.freezeProfile(profile);
      for (const target of TARGETS) await this.data.deleteTarget({ ...profile, target });
      deleted.push(structuredClone(profile));
    }
    return deleted;
  }

  async #createTask(
    kind: PrivacyTask['kind'],
    input: PrivacyScope & { requestedByGuardianId: string },
  ): Promise<PrivacyTask> {
    const now = this.#clock.now;
    const task: PrivacyTask = {
      ...this.#scope(input),
      attempts: 0,
      completedAt: null,
      createdAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 30 * DAY).toISOString(),
      download: null,
      errorCode: null,
      id: randomUUID(),
      kind,
      requestedByGuardianId: required(input.requestedByGuardianId, '监护人'),
      status: 'pending',
      targetReceipts: {},
      updatedAt: now.toISOString(),
    };
    return this.store.createTask(task);
  }
  #scope(input: PrivacyScope): PrivacyScope {
    return {
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      learningProfileId: required(input.learningProfileId, '学习档案'),
    };
  }
  #subjectToken(profileId: string): string {
    return createHmac('sha256', this.tombstonePepper).update(profileId).digest('hex');
  }
}
