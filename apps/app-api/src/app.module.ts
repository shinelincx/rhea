import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { FamilyAccess } from '@rhea/family-access';
import type { JobClient } from '@rhea/job-runtime';
import type { AssessmentService, SuggestedAssessmentService } from '@rhea/assessment';
import type { GeneratedLearningService } from '@rhea/generated-learning';

import { AssessmentController } from './assessment/assessment.controller.js';
import { AssessmentExceptionFilter } from './assessment/assessment-exception.filter.js';
import {
  ASSESSMENT_SERVICE,
  SUGGESTED_ASSESSMENT_SERVICE,
} from './assessment/assessment.provider.js';
import { ProfessionalReviewController } from './assessment/professional-review.controller.js';
import {
  PROFESSIONAL_REVIEW_ACCESS,
  type ProfessionalReviewAccess,
} from './assessment/professional-review.provider.js';
import { DEPENDENCY_PROBES, type DependencyProbe } from './health/dependency-probe.js';
import { FamilyAccessController } from './family-access/family-access.controller.js';
import { FamilyAccessExceptionFilter } from './family-access/family-access-exception.filter.js';
import { FAMILY_ACCESS } from './family-access/family-access.provider.js';
import { HealthController } from './health/health.controller.js';
import { JOB_CLIENT } from './jobs/job-client.js';
import { LearningContentController } from './learning-content/learning-content.controller.js';
import { LearningContentExceptionFilter } from './learning-content/learning-content-exception.filter.js';
import {
  LEARNING_CONTENT_SERVICE,
  type LearningContentService,
} from './learning-content/learning-content.provider.js';
import { ProbeJobsController } from './jobs/probe-jobs.controller.js';
import { SubmissionController } from './submission/submission.controller.js';
import { SubmissionExceptionFilter } from './submission/submission-exception.filter.js';
import {
  SUBMISSION_SCHEDULER,
  SUBMISSION_SERVICE,
  type SubmissionScheduler,
  type SubmissionService,
} from './submission/submission.provider.js';
import { TodayRouteController } from './today-route.controller.js';
import { GeneratedLearningController } from './generated-learning/generated-learning.controller.js';
import { GeneratedLearningExceptionFilter } from './generated-learning/generated-learning-exception.filter.js';
import {
  GENERATED_LEARNING_SCHEDULER,
  GENERATED_LEARNING_SERVICE,
  type GeneratedLearningScheduler,
} from './generated-learning/generated-learning.provider.js';

@Module({})
export class AppModule {
  static register(
    dependencyProbes: DependencyProbe[],
    jobClient: JobClient,
    familyAccess: FamilyAccess,
    assessmentService: AssessmentService,
    suggestedAssessmentService: SuggestedAssessmentService,
    professionalReviewAccess: ProfessionalReviewAccess,
    learningContentService: LearningContentService,
    submissionService: SubmissionService,
    submissionScheduler: SubmissionScheduler,
    generatedLearningService: GeneratedLearningService,
    generatedLearningScheduler: GeneratedLearningScheduler,
    shutdownResources: Array<{ close(): Promise<void> }>,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AssessmentController,
        FamilyAccessController,
        GeneratedLearningController,
        HealthController,
        LearningContentController,
        ProbeJobsController,
        ProfessionalReviewController,
        SubmissionController,
        TodayRouteController,
      ],
      providers: [
        {
          provide: APP_FILTER,
          useClass: AssessmentExceptionFilter,
        },
        {
          provide: APP_FILTER,
          useClass: FamilyAccessExceptionFilter,
        },
        {
          provide: APP_FILTER,
          useClass: SubmissionExceptionFilter,
        },
        {
          provide: APP_FILTER,
          useClass: LearningContentExceptionFilter,
        },
        {
          provide: APP_FILTER,
          useClass: GeneratedLearningExceptionFilter,
        },
        {
          provide: ASSESSMENT_SERVICE,
          useValue: assessmentService,
        },
        {
          provide: SUGGESTED_ASSESSMENT_SERVICE,
          useValue: suggestedAssessmentService,
        },
        {
          provide: PROFESSIONAL_REVIEW_ACCESS,
          useValue: professionalReviewAccess,
        },
        {
          provide: FAMILY_ACCESS,
          useValue: familyAccess,
        },
        {
          provide: DEPENDENCY_PROBES,
          useValue: dependencyProbes,
        },
        {
          provide: JOB_CLIENT,
          useValue: jobClient,
        },
        {
          provide: LEARNING_CONTENT_SERVICE,
          useValue: learningContentService,
        },
        {
          provide: SUBMISSION_SERVICE,
          useValue: submissionService,
        },
        {
          provide: SUBMISSION_SCHEDULER,
          useValue: submissionScheduler,
        },
        {
          provide: GENERATED_LEARNING_SERVICE,
          useValue: generatedLearningService,
        },
        {
          provide: GENERATED_LEARNING_SCHEDULER,
          useValue: generatedLearningScheduler,
        },
        ...shutdownResources.map((resource, index) => ({
          provide: `SHUTDOWN_RESOURCE_${index}`,
          useValue: {
            async onApplicationShutdown() {
              await resource.close();
            },
          },
        })),
      ],
    };
  }
}
