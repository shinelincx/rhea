import { createJobWorker, type BullMqOptions, type JobHandler } from '@rhea/queue-adapter';

import type { WorkerRole } from './config.js';

export interface RoleJobHandlers {
  submissionRecognitionHandler?: JobHandler;
  generatedLearningHandler?: JobHandler;
  openAssessmentHandler?: JobHandler;
  reviewCardHandler?: JobHandler;
  privacyTaskHandler?: JobHandler;
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

    if (input.kind === 'privacy.process') {
      if (role !== 'safety') throw new Error('JOB_KIND_NOT_ALLOWED_FOR_ROLE');
      if (!handlers.privacyTaskHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.privacyTaskHandler(input);
    }

    if (role !== 'ai') {
      throw new Error('JOB_KIND_NOT_ALLOWED_FOR_ROLE');
    }
    if (input.kind === 'submission.recognize') {
      if (!handlers.submissionRecognitionHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.submissionRecognitionHandler(input);
    }
    if (input.kind === 'generated-learning.generate') {
      if (!handlers.generatedLearningHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.generatedLearningHandler(input);
    }
    if (input.kind === 'open-assessment.generate') {
      if (!handlers.openAssessmentHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.openAssessmentHandler(input);
    }
    if (input.kind === 'review-card.generate') {
      if (!handlers.reviewCardHandler) throw new Error('JOB_HANDLER_UNAVAILABLE');
      return handlers.reviewCardHandler(input);
    }
    throw new Error('JOB_KIND_NOT_ALLOWED_FOR_ROLE');
  };
}

export function createRoleWorker(options: RoleWorkerOptions, handlers: RoleJobHandlers = {}) {
  return createJobWorker(options, createRoleJobHandler(options.role, handlers));
}
