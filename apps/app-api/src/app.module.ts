import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { FamilyAccess } from '@rhea/family-access';
import type { JobClient } from '@rhea/job-runtime';

import { DEPENDENCY_PROBES, type DependencyProbe } from './health/dependency-probe.js';
import { FamilyAccessController } from './family-access/family-access.controller.js';
import { FamilyAccessExceptionFilter } from './family-access/family-access-exception.filter.js';
import { FAMILY_ACCESS } from './family-access/family-access.provider.js';
import { HealthController } from './health/health.controller.js';
import { JOB_CLIENT } from './jobs/job-client.js';
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

@Module({})
export class AppModule {
  static register(
    dependencyProbes: DependencyProbe[],
    jobClient: JobClient,
    familyAccess: FamilyAccess,
    submissionService: SubmissionService,
    submissionScheduler: SubmissionScheduler,
    shutdownResources: Array<{ close(): Promise<void> }>,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        FamilyAccessController,
        HealthController,
        ProbeJobsController,
        SubmissionController,
        TodayRouteController,
      ],
      providers: [
        {
          provide: APP_FILTER,
          useClass: FamilyAccessExceptionFilter,
        },
        {
          provide: APP_FILTER,
          useClass: SubmissionExceptionFilter,
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
          provide: SUBMISSION_SERVICE,
          useValue: submissionService,
        },
        {
          provide: SUBMISSION_SCHEDULER,
          useValue: submissionScheduler,
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
