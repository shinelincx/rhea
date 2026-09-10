import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';
import {
  GeneratedLearningService,
  MemoryGeneratedLearningStore,
  type GeneratedLearningCapability,
  type ModelGatewayPort,
} from '@rhea/generated-learning';
import type { LearningContentService } from '@rhea/learning-content';

import { createLocalCapabilityAuthorization } from '../quality-control/local-capability-authorization.js';
import type { GeneratedLearningScheduler } from './generated-learning.provider.js';

function ageBandForGrade(
  grade: number | null,
): 'lower_primary' | 'middle_primary' | 'upper_primary' {
  if (grade === null || grade <= 2) return 'lower_primary';
  return grade <= 4 ? 'middle_primary' : 'upper_primary';
}

export function createLocalGeneratedLearning(
  learningContent: LearningContentService,
  consentReader: AiProcessingConsentPublicationReader,
  options: {
    capability?: GeneratedLearningCapability;
    modelGateway?: ModelGatewayPort;
  } = {},
): { scheduler: GeneratedLearningScheduler; service: GeneratedLearningService } {
  const service = new GeneratedLearningService({
    basisReader: learningContent,
    modelGateway:
      options.modelGateway ??
      ({
        async runStructured() {
          throw new Error('MODEL_CAPABILITY_UNAVAILABLE');
        },
      } satisfies ModelGatewayPort),
    publicationGate: {
      async authorize(input) {
        const consent = await consentReader.getAiProcessingConsentSnapshotForPublication({
          familySpaceId: input.familySpaceId,
          learningProfileId: input.learningProfileId,
        });
        return (
          consent?.status === 'granted' &&
          consent.revision === input.consentRevision &&
          ageBandForGrade(consent.grade) === input.ageBand
        );
      },
    },
    qualityControl: createLocalCapabilityAuthorization(options.capability ?? null),
    store: new MemoryGeneratedLearningStore(),
  });
  return {
    scheduler: {
      async schedule(request) {
        setTimeout(
          () =>
            void service
              .processRequest({
                learningProfileId: request.learningProfileId,
                requestId: request.id,
              })
              .catch(() => undefined),
          0,
        );
      },
    },
    service,
  };
}
