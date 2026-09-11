import type { SuggestedAssessmentService, SuggestedAssessmentStatus } from '@rhea/assessment';
import type { JobHandler } from '@rhea/queue-adapter';

export interface OpenAssessmentProcessor {
  processSuggestion(input: { learningProfileId: string; suggestionId: string }): Promise<{
    id: string;
    status: SuggestedAssessmentStatus;
    unavailableReason: string | null;
  }>;
}

export class OpenAssessmentActiveLeaseError extends Error {
  readonly code = 'OPEN_ASSESSMENT_ACTIVE_LEASE';

  constructor() {
    super('Open assessment is already processing under an active lease');
    this.name = 'OpenAssessmentActiveLeaseError';
  }
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('INVALID_OPEN_ASSESSMENT_JOB_PAYLOAD');
  }
  return value;
}

export function createOpenAssessmentJobHandler(
  processor: Pick<SuggestedAssessmentService, 'processSuggestion'> | OpenAssessmentProcessor,
): JobHandler {
  return async (input) => {
    if (input.kind !== 'open-assessment.generate') throw new Error('UNSUPPORTED_JOB_KIND');
    const result = await processor.processSuggestion({
      learningProfileId: requiredIdentifier(input.payload.learningProfileId),
      suggestionId: requiredIdentifier(input.payload.suggestionId),
    });
    if (result.status === 'generating') throw new OpenAssessmentActiveLeaseError();
    return {
      status: result.status,
      suggestionId: result.id,
      unavailableReason: result.unavailableReason,
    };
  };
}
