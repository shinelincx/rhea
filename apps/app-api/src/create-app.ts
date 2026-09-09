import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createMemoryJobRuntime, type JobClient } from '@rhea/job-runtime';
import { createInMemoryFamilyAccess, type FamilyAccess } from '@rhea/family-access';

import { AppModule } from './app.module.js';
import type { DependencyProbe } from './health/dependency-probe.js';
import { createEnvironmentDependencyProbes } from './health/environment-probes.js';

export interface CreateAppOptions {
  allowedOrigins?: string[];
  dependencyProbes?: DependencyProbe[];
  familyAccess?: FamilyAccess;
  jobClient?: JobClient;
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

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(dependencyProbes, jobClient, familyAccess, options.shutdownResources ?? []),
    new FastifyAdapter(),
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
