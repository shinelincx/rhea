import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { JobClient } from '@rhea/job-runtime';

import { DEPENDENCY_PROBES, type DependencyProbe } from './health/dependency-probe.js';
import { HealthController } from './health/health.controller.js';
import { JOB_CLIENT } from './jobs/job-client.js';
import { ProbeJobsController } from './jobs/probe-jobs.controller.js';
import { TodayRouteController } from './today-route.controller.js';

@Module({})
export class AppModule {
  static register(dependencyProbes: DependencyProbe[], jobClient: JobClient): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProbeJobsController, TodayRouteController],
      providers: [
        {
          provide: DEPENDENCY_PROBES,
          useValue: dependencyProbes,
        },
        {
          provide: JOB_CLIENT,
          useValue: jobClient,
        },
      ],
    };
  }
}
