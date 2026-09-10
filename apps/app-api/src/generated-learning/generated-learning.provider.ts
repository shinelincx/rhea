import type {
  GeneratedLearningRequestView,
  GeneratedLearningService,
} from '@rhea/generated-learning';

export const GENERATED_LEARNING_SERVICE = Symbol('GENERATED_LEARNING_SERVICE');
export type { GeneratedLearningService };

export interface GeneratedLearningScheduler {
  schedule(request: GeneratedLearningRequestView): Promise<void>;
}

export const GENERATED_LEARNING_SCHEDULER = Symbol('GENERATED_LEARNING_SCHEDULER');
