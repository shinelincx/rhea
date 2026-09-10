import type {
  GeneratedLearningContentVersion,
  GenerationCheck,
  ModelRunRecord,
  StoredGenerationRequest,
} from './types.js';

export type GenerationCompletionResult =
  'completed' | 'conflict' | 'consent_withdrawn' | 'source_changed';

export interface GeneratedLearningStore {
  cancel(input: {
    expectedStateRevision: number;
    learningProfileId: string;
    reason: 'GENERATION_CANCELED';
    requestId: string;
    updatedAt: string;
  }): Promise<boolean>;
  complete(input: {
    expectedStateRevision: number;
    latestChecks: GenerationCheck[];
    learningProfileId: string;
    modelRuns: ModelRunRecord[];
    requestId: string;
    version: GeneratedLearningContentVersion;
  }): Promise<GenerationCompletionResult>;
  create(request: StoredGenerationRequest): Promise<boolean>;
  fail(input: {
    expectedStateRevision: number;
    latestChecks: GenerationCheck[];
    learningProfileId: string;
    modelRuns: ModelRunRecord[];
    reason: NonNullable<StoredGenerationRequest['unavailableReason']>;
    requestId: string;
    updatedAt: string;
  }): Promise<boolean>;
  findByIdempotencyKey(
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<StoredGenerationRequest | null>;
  findLatestReadyForSource(
    sourceKey: string,
    learningProfileId: string,
  ): Promise<StoredGenerationRequest | null>;
  findById(id: string, learningProfileId: string): Promise<StoredGenerationRequest | null>;
  markGenerating(input: {
    expectedStateRevision: number;
    leaseExpiresAt: string;
    learningProfileId: string;
    now: string;
    requestId: string;
    updatedAt: string;
  }): Promise<boolean>;
  recordHintUsage(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    expectedLevel: 0 | 1 | 2;
    learningProfileId: string;
    nextLevel: 1 | 2 | 3;
    occurredAt: string;
    requestId: string;
    versionId: string;
  }): Promise<GenerationCompletionResult>;
}
