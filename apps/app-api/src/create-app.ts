import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createInMemoryFamilyAccess,
  type AiProcessingConsentPublicationReader,
  type ChallengeAuthorizationPublicationReader,
  type FamilyAccess,
} from '@rhea/family-access';
import { createMemoryJobRuntime, type JobClient } from '@rhea/job-runtime';
import type { AssessmentService, SuggestedAssessmentService } from '@rhea/assessment';
import type { ChallengeAuthorizationPort, ChallengeService } from '@rhea/challenge';
import type { GeneratedLearningService } from '@rhea/generated-learning';
import type { LearningContentService } from '@rhea/learning-content';
import type { LearningProgressService, ReviewCardService } from '@rhea/learning-progress';
import type { SubmissionService } from '@rhea/submission';
import { MemoryReportingStore, ReportingService } from '@rhea/reporting';

import { AppModule } from './app.module.js';
import type { DependencyProbe } from './health/dependency-probe.js';
import { createLocalAssessment } from './assessment/create-local-assessment.js';
import { createLocalSuggestedAssessment } from './assessment/create-local-suggested-assessment.js';
import {
  type ProfessionalReviewAccess,
  unavailableProfessionalReviewAccess,
} from './assessment/professional-review.provider.js';
import { createEnvironmentDependencyProbes } from './health/environment-probes.js';
import { createLocalLearningContent } from './learning-content/create-local-learning-content.js';
import { createLocalSubmission } from './submission/create-local-submission.js';
import type { SubmissionScheduler } from './submission/submission.provider.js';
import { createLocalGeneratedLearning } from './generated-learning/create-local-generated-learning.js';
import type { GeneratedLearningScheduler } from './generated-learning/generated-learning.provider.js';
import type { SuggestedAssessmentScheduler } from './assessment/assessment.provider.js';
import { createLocalLearningProgressBundle } from './learning-progress/create-local-learning-progress.js';
import type { ReviewCardScheduler } from './learning-progress/learning-progress.provider.js';
import { createLocalChallenge } from './challenge/create-local-challenge.js';

export interface CreateAppOptions {
  allowedOrigins?: string[];
  assessmentService?: AssessmentService;
  challengeService?: ChallengeService;
  suggestedAssessmentService?: SuggestedAssessmentService;
  suggestedAssessmentScheduler?: SuggestedAssessmentScheduler;
  dependencyProbes?: DependencyProbe[];
  familyAccess?: FamilyAccess;
  generatedLearningConsentReader?: AiProcessingConsentPublicationReader;
  generatedLearningScheduler?: GeneratedLearningScheduler;
  generatedLearningService?: GeneratedLearningService;
  jobClient?: JobClient;
  learningContentService?: LearningContentService;
  learningProgressService?: LearningProgressService;
  reviewCardScheduler?: ReviewCardScheduler;
  reviewCardService?: ReviewCardService;
  reportingService?: ReportingService;
  professionalReviewAccess?: ProfessionalReviewAccess;
  submissionScheduler?: SubmissionScheduler;
  submissionService?: SubmissionService;
  shutdownResources?: Array<{ close(): Promise<void> }>;
}

function isConsentPublicationReader(
  value: FamilyAccess,
): value is FamilyAccess & AiProcessingConsentPublicationReader {
  return 'getAiProcessingConsentSnapshotForPublication' in value;
}

function challengeAuthorization(value: FamilyAccess): ChallengeAuthorizationPort {
  const reader = value as FamilyAccess & Partial<ChallengeAuthorizationPublicationReader>;
  return {
    async getChallengeAuthorization(actor) {
      if (!reader.getChallengeAuthorizationSnapshot) return null;
      return reader.getChallengeAuthorizationSnapshot(actor);
    },
  };
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
  const submissions = options.submissionService ?? localSubmission.service;
  const learningContent = options.learningContentService ?? createLocalLearningContent();
  const assessment =
    options.assessmentService ?? createLocalAssessment(learningContent, submissions);
  const consentReader =
    options.generatedLearningConsentReader ??
    (isConsentPublicationReader(familyAccess)
      ? familyAccess
      : { getAiProcessingConsentSnapshotForPublication: async () => null });
  const localLearningProgress = createLocalLearningProgressBundle(
    assessment,
    learningContent,
    consentReader,
  );
  const learningProgress = options.learningProgressService ?? localLearningProgress.service;
  const reviewCards = options.reviewCardService ?? localLearningProgress.reviewCardService;
  const reviewCardScheduler: ReviewCardScheduler = options.reviewCardScheduler ?? {
    async schedule(request) {
      setTimeout(() => {
        void reviewCards
          .processRequest({ learningProfileId: request.learningProfileId, requestId: request.id })
          .catch(() => undefined);
      }, 0);
    },
  };
  const suggestedAssessment =
    options.suggestedAssessmentService ??
    createLocalSuggestedAssessment(learningContent, submissions, consentReader);
  const suggestedAssessmentScheduler: SuggestedAssessmentScheduler =
    options.suggestedAssessmentScheduler ?? {
      async schedule(request) {
        setTimeout(() => {
          void suggestedAssessment.processSuggestion({
            learningProfileId: request.learningProfileId,
            suggestionId: request.id,
          });
        }, 0);
      },
    };
  const generatedLearning = createLocalGeneratedLearning(learningContent, consentReader);
  const reporting =
    options.reportingService ?? new ReportingService({ store: new MemoryReportingStore() });
  const challenge =
    options.challengeService ?? createLocalChallenge(challengeAuthorization(familyAccess));
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
      challenge,
      assessment,
      suggestedAssessment,
      suggestedAssessmentScheduler,
      options.professionalReviewAccess ?? unavailableProfessionalReviewAccess,
      learningContent,
      learningProgress,
      reviewCards,
      reviewCardScheduler,
      consentReader,
      submissions,
      options.submissionScheduler ?? localSubmission.scheduler,
      options.generatedLearningService ?? generatedLearning.service,
      options.generatedLearningScheduler ?? generatedLearning.scheduler,
      reporting,
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
