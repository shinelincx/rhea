import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';
import {
  GeneratedLearningService,
  MemoryGeneratedLearningStore,
  type GeneratedLearningCapability,
  type ModelGatewayPort,
} from '@rhea/generated-learning';
import type { LearningContentService } from '@rhea/learning-content';

import type { GeneratedLearningScheduler } from './generated-learning.provider.js';

export const UNAVAILABLE_GENERATED_LEARNING_CAPABILITY: GeneratedLearningCapability = {
  adapterVersion: 'unconfigured',
  availability: 'unavailable',
  id: 'learning-pack-unavailable-v1',
  modelVersion: 'unconfigured',
  policyVersion: 'child-learning-policy-v1',
  region: 'cn-shanghai',
  templateVersion: 'lesson-support-template-v1',
};

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
    capability: options.capability ?? UNAVAILABLE_GENERATED_LEARNING_CAPABILITY,
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
