import type { ProcessingJobView, SubmissionService } from '@rhea/submission';

export const SUBMISSION_SERVICE = Symbol('SUBMISSION_SERVICE');
export type { SubmissionService };

export interface SubmissionScheduler {
  schedule(job: ProcessingJobView, learningProfileId: string): void;
}

export const SUBMISSION_SCHEDULER = Symbol('SUBMISSION_SCHEDULER');
