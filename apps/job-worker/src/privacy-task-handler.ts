import type { PrivacyLifecycleService } from '@rhea/privacy-lifecycle';
import type { JobHandler } from '@rhea/queue-adapter';

export function createPrivacyTaskJobHandler(
  processor: Pick<PrivacyLifecycleService, 'processTask'>,
): JobHandler {
  return async (input) => {
    if (input.kind !== 'privacy.process') throw new Error('UNSUPPORTED_JOB_KIND');
    const taskId = input.payload.taskId.trim();
    if (!taskId || taskId.length > 200) throw new Error('INVALID_PRIVACY_JOB_PAYLOAD');
    const task = await processor.processTask(taskId);
    if (task.status === 'retry_scheduled') throw new Error('PRIVACY_TASK_RETRY_REQUIRED');
    return { status: task.status, taskId: task.id };
  };
}
