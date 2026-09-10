import type { CurrentLearningContextReference } from '@rhea/learning-content';

import type { ModelTask, ModelTaskResult } from './types.js';
import type { AgeBand, GeneratedLearningCapability } from './types.js';

export interface ModelGatewayPort {
  runStructured(task: ModelTask): Promise<ModelTaskResult>;
}

export interface CurrentGenerationBasisReader {
  getCurrentLearningContextReference(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    learningProfileId: string;
    materialId: string;
  }): Promise<CurrentLearningContextReference>;
}

export interface GenerationPublicationGate {
  authorize(input: {
    ageBand: AgeBand;
    capability: GeneratedLearningCapability;
    consentRevision: number;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<boolean>;
}
