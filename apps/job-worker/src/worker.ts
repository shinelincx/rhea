import { createJobWorker, type BullMqOptions, type JobHandler } from '@rhea/queue-adapter';

import type { WorkerRole } from './config.js';

export interface RoleJobHandlers {
  generatedLearningHandler?: JobHandler;
  openAssessmentHandler?: JobHandler;
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
    if (input.kind === 'generated-learning.generate') {
      if (!handlers.generatedLearningHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.generatedLearningHandler(input);
    }
    if (input.kind === 'open-assessment.generate') {
      if (!handlers.openAssessmentHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.openAssessmentHandler(input);
    }
    throw new Error('JOB_KIND_NOT_ALLOWED_FOR_ROLE');
  };
}

export function createRoleWorker(options: RoleWorkerOptions, handlers: RoleJobHandlers = {}) {
  return createJobWorker(options, createRoleJobHandler(options.role, handlers));
}
