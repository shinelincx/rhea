import { describe, expect, it, vi } from 'vitest';

import { createPrivacyTaskJobHandler } from '../src/privacy-task-handler.js';

describe('privacy task job handler', () => {
  it('returns completed tasks and retries partial target failures', async () => {
    const processTask = vi
      .fn()
      .mockResolvedValueOnce({ id: 'privacy-1', status: 'completed' })
      .mockResolvedValueOnce({ id: 'privacy-2', status: 'retry_scheduled' });
    const handler = createPrivacyTaskJobHandler({ processTask } as never);
    await expect(
      handler({ kind: 'privacy.process', payload: { taskId: 'privacy-1' } }),
    ).resolves.toEqual({ status: 'completed', taskId: 'privacy-1' });
    await expect(
      handler({ kind: 'privacy.process', payload: { taskId: 'privacy-2' } }),
    ).rejects.toThrow('PRIVACY_TASK_RETRY_REQUIRED');
  });
});
