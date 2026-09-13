import { describe, expect, it } from 'vitest';

import type { ErasureTarget, PrivacyDataPort, PrivacyScope } from '../src/index.js';
import {
  MemoryPrivacyDataPort,
  MemoryPrivacyLifecycleStore,
  PrivacyLifecycleService,
} from '../src/index.js';

const scope = { familySpaceId: 'family-1', learningProfileId: 'profile-1' };
const pepper = 'privacy-tombstone-test-pepper-32-bytes';

describe('PrivacyLifecycleService', () => {
  it('exports content with source and state histories after creating a queryable task', async () => {
    const store = new MemoryPrivacyLifecycleStore();
    const service = new PrivacyLifecycleService(store, new MemoryPrivacyDataPort(), pepper, {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    const task = await service.requestExport({ ...scope, requestedByGuardianId: 'guardian-1' });
    expect(await service.getTask(task.id)).toMatchObject({ kind: 'export', status: 'pending' });

    const completed = await service.processTask(task.id);
    expect(completed).toMatchObject({
      attempts: 1,
      download: { objectKey: `exports/${task.id}.json.enc` },
      status: 'completed',
    });
  });

  it('requires exact confirmation, freezes immediately, deletes every target and saves a content-free tombstone', async () => {
    const store = new MemoryPrivacyLifecycleStore();
    const data = new MemoryPrivacyDataPort();
    const service = new PrivacyLifecycleService(store, data, pepper, {
      now: new Date('2026-09-13T08:00:00.000Z'),
    });
    const preview = service.previewErasure(scope);
    expect(preview).toMatchObject({
      deadlineDays: 30,
      targets: expect.arrayContaining(['key_wrap']),
    });
    await expect(
      service.requestErasure({
        ...scope,
        confirmationText: '删除',
        requestedByGuardianId: 'guardian-1',
      }),
    ).rejects.toThrow('删除确认文字不匹配');
    expect(data.frozen).toHaveLength(0);

    const task = await service.requestErasure({
      ...scope,
      confirmationText: preview.confirmationText,
      requestedByGuardianId: 'guardian-1',
    });
    expect(data.frozen).toEqual([scope]);
    const completed = await service.processTask(task.id);
    expect(completed.status).toBe('completed');
    expect(data.deleted.map(({ target }) => target)).toEqual([
      'cache',
      'vendor_copies',
      'object_storage',
      'key_wrap',
      'active_database',
    ]);
    expect(store.tombstones[0]).toMatchObject({
      completionCertificateId: expect.any(String),
      subjectToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      targetNames: expect.arrayContaining(['active_database', 'key_wrap']),
    });
    expect(JSON.stringify(store.tombstones)).not.toContain(scope.learningProfileId);
  });

  it('retries from the first unconfirmed target and replays tombstones after a restore', async () => {
    class RetryData implements PrivacyDataPort {
      readonly calls: ErasureTarget[] = [];
      failedOnce = false;
      async archiveTombstone() {}
      async deleteTarget(input: PrivacyScope & { target: ErasureTarget }) {
        this.calls.push(input.target);
        if (input.target === 'object_storage' && !this.failedOnce) {
          this.failedOnce = true;
          throw new Error('temporary');
        }
        return { receipt: `${input.target}:deleted` };
      }
      async exportProfile(): Promise<never> {
        throw new Error('not used');
      }
      async downloadExport(): Promise<never> {
        throw new Error('not used');
      }
      async freezeProfile() {}
      async profileExists() {
        return true;
      }
      async purgeExpiredExports() {
        return 0;
      }
    }
    const store = new MemoryPrivacyLifecycleStore();
    const data = new RetryData();
    const service = new PrivacyLifecycleService(store, data, pepper);
    const preview = service.previewErasure(scope);
    const task = await service.requestErasure({
      ...scope,
      confirmationText: preview.confirmationText,
      requestedByGuardianId: 'guardian-1',
    });
    expect((await service.processTask(task.id)).status).toBe('retry_scheduled');
    expect((await service.processTask(task.id)).status).toBe('completed');
    expect(data.calls.filter((target) => target === 'cache')).toHaveLength(1);
    expect(data.calls.filter((target) => target === 'object_storage')).toHaveLength(2);

    const replayed = await service.replayTombstones([
      scope,
      { familySpaceId: 'family-2', learningProfileId: 'profile-2' },
    ]);
    expect(replayed).toEqual([scope]);
  });
});
