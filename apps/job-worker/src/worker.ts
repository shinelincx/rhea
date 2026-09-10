import { createJobWorker, type BullMqOptions, type JobHandler } from '@rhea/queue-adapter';

import type { WorkerRole } from './config.js';

export interface RoleJobHandlers {
  generatedLearningHandler?: JobHandler;
}

export interface RoleWorkerOptions extends BullMqOptions {
  role: WorkerRole;
}

export function createRoleJobHandler(role: WorkerRole, handlers: RoleJobHandlers = {}): JobHandler {
  return async (input) => {
    if (input.kind === 'system.probe') {
      if (input.payload.outcome === 'failure') {
        throw new Error('JOB_HANDLER_FAILED');
      }

      return { message: 'processed' };
    }

    if (role !== 'ai') {
      throw new Error('JOB_KIND_NOT_ALLOWED_FOR_ROLE');
    }
    if (!handlers.generatedLearningHandler) {
      throw new Error('JOB_HANDLER_UNAVAILABLE');
    }

    return handlers.generatedLearningHandler(input);
  };
}

export function createRoleWorker(options: RoleWorkerOptions, handlers: RoleJobHandlers = {}) {
  return createJobWorker(options, createRoleJobHandler(options.role, handlers));
}
