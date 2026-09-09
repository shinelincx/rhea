import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess, type FamilyAccess } from '@rhea/family-access';
import { createMemoryJobRuntime, type JobClient } from '@rhea/job-runtime';
import type { LearningContentService } from '@rhea/learning-content';
import type { SubmissionService } from '@rhea/submission';

import { AppModule } from './app.module.js';
import type { DependencyProbe } from './health/dependency-probe.js';
import { createEnvironmentDependencyProbes } from './health/environment-probes.js';
import { createLocalLearningContent } from './learning-content/create-local-learning-content.js';
import { createLocalSubmission } from './submission/create-local-submission.js';
import type { SubmissionScheduler } from './submission/submission.provider.js';

export interface CreateAppOptions {
  allowedOrigins?: string[];
  dependencyProbes?: DependencyProbe[];
  familyAccess?: FamilyAccess;
  jobClient?: JobClient;
  learningContentService?: LearningContentService;
  submissionScheduler?: SubmissionScheduler;
  submissionService?: SubmissionService;
  shutdownResources?: Array<{ close(): Promise<void> }>;
}

const LOCAL_WEB_ORIGINS = ['http://127.0.0.1:8081', 'http://localhost:8081'];

function configuredOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) {
    return LOCAL_WEB_ORIGINS;
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function createApp(options: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const dependencyProbes = options.dependencyProbes ?? createEnvironmentDependencyProbes();
  const familyAccess = options.familyAccess ?? createInMemoryFamilyAccess();
  const jobClient = options.jobClient ?? createMemoryJobRuntime();
  const localSubmission = createLocalSubmission();
  const learningContent = options.learningContentService ?? createLocalLearningContent();
  const adapter = new FastifyAdapter({ bodyLimit: 16 * 1024 * 1024 });
  adapter
    .getInstance()
    .addContentTypeParser(
      ['application/pdf', 'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'],
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(
      dependencyProbes,
      jobClient,
      familyAccess,
      learningContent,
      options.submissionService ?? localSubmission.service,
      options.submissionScheduler ?? localSubmission.scheduler,
      options.shutdownResources ?? [],
    ),
    adapter,
    {
      logger: false,
    },
  );
  app.enableCors({
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    origin: options.allowedOrigins ?? configuredOrigins(),
  });
  return app;
}
