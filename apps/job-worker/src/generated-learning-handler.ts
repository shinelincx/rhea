import type { JobHandler } from '@rhea/queue-adapter';
import type {
  GenerationRequestStatus,
  GenerationUnavailableReason,
} from '@rhea/generated-learning';

export interface GeneratedLearningProcessor {
  processRequest(input: { learningProfileId: string; requestId: string }): Promise<{
    id: string;
    status: GenerationRequestStatus;
    unavailableReason: GenerationUnavailableReason | null;
  }>;
}

export class GeneratedLearningActiveLeaseError extends Error {
  readonly code = 'GENERATED_LEARNING_ACTIVE_LEASE';

  constructor() {
    super('Generated learning is already processing under an active lease');
    this.name = 'GeneratedLearningActiveLeaseError';
  }
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('INVALID_GENERATED_LEARNING_JOB_PAYLOAD');
  }
  return value;
}

export function createGeneratedLearningJobHandler(
  processor: GeneratedLearningProcessor,
): JobHandler {
  return async (input) => {
    if (input.kind !== 'generated-learning.generate') {
      throw new Error('UNSUPPORTED_JOB_KIND');
    }
    const result = await processor.processRequest({
      learningProfileId: requiredIdentifier(input.payload.learningProfileId),
      requestId: requiredIdentifier(input.payload.requestId),
    });
    if (result.status === 'generating') {
      throw new GeneratedLearningActiveLeaseError();
    }
    return {
      requestId: result.id,
      status: result.status,
      unavailableReason: result.unavailableReason,
    };
  };
}
