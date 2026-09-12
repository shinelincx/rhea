import type {
  LearningProgressService,
  ReviewCardRequestView,
  ReviewCardService,
} from '@rhea/learning-progress';
import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';

export const LEARNING_PROGRESS_SERVICE = Symbol('LEARNING_PROGRESS_SERVICE');

export type { LearningProgressService };

export const REVIEW_CARD_SERVICE = Symbol('REVIEW_CARD_SERVICE');
export type { ReviewCardService };

export interface ReviewCardScheduler {
  schedule(request: ReviewCardRequestView): Promise<void>;
}

export const REVIEW_CARD_SCHEDULER = Symbol('REVIEW_CARD_SCHEDULER');
export const REVIEW_CARD_CONSENT_READER = Symbol('REVIEW_CARD_CONSENT_READER');
export type { AiProcessingConsentPublicationReader };
