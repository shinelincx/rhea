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
import { TodayRouteController } from './today-route.controller.js';

@Module({})
export class AppModule {
  static register(
    dependencyProbes: DependencyProbe[],
    jobClient: JobClient,
    familyAccess: FamilyAccess,
    shutdownResources: Array<{ close(): Promise<void> }>,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        FamilyAccessController,
        HealthController,
        ProbeJobsController,
        TodayRouteController,
      ],
      providers: [
        {
          provide: APP_FILTER,
          useClass: FamilyAccessExceptionFilter,
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
