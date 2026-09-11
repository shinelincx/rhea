import type {
  GeneratedLearningPackCandidate,
  ModelGatewayPort,
  ModelTask,
  ModelTaskResult,
} from '@rhea/generated-learning';
import type {
  OpenAssessmentModelGatewayPort,
  OpenAssessmentModelResult,
  OpenAssessmentModelTask,
} from '@rhea/assessment';

export interface HttpModelGatewayOptions {
  authorizationToken?: string;
  timeoutMs?: number;
  url: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MODEL_GATEWAY_INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

async function postStructuredTask(
  options: HttpModelGatewayOptions,
  task: ModelTask | OpenAssessmentModelTask,
): Promise<Record<string, unknown>> {
  const response = await fetch(options.url, {
    body: JSON.stringify({ task }),
    headers: {
      'content-type': 'application/json',
      ...(options.authorizationToken
        ? { authorization: `Bearer ${options.authorizationToken}` }
        : {}),
    },
    method: 'POST',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`MODEL_GATEWAY_HTTP_${response.status}`);
  return record(await response.json());
}

function commonResult(value: Record<string, unknown>) {
  if (
    typeof value.provider !== 'string' ||
    !value.provider.trim() ||
    (value.externalTraceId !== null && typeof value.externalTraceId !== 'string') ||
    (value.inputTokens !== null && typeof value.inputTokens !== 'number') ||
    (value.outputTokens !== null && typeof value.outputTokens !== 'number')
  ) {
    throw new Error('MODEL_GATEWAY_INVALID_RESPONSE');
  }
  return {
    externalTraceId: value.externalTraceId as string | null,
    inputTokens: value.inputTokens as number | null,
    outputTokens: value.outputTokens as number | null,
    provider: value.provider,
  };
}

export class HttpOpenAssessmentModelGateway implements OpenAssessmentModelGatewayPort {
  constructor(private readonly options: HttpModelGatewayOptions) {}

  async runStructured(task: OpenAssessmentModelTask): Promise<OpenAssessmentModelResult> {
    const value = await postStructuredTask(this.options, task);
    return {
      ...commonResult(value),
      candidate: record(value.candidate) as unknown as OpenAssessmentModelResult['candidate'],
    };
  }
}

export function createConfiguredOpenAssessmentModelGateway(
  environment: Record<string, string | undefined>,
): OpenAssessmentModelGatewayPort {
  const url = environment.MODEL_GATEWAY_URL?.trim();
  const token = environment.MODEL_GATEWAY_TOKEN?.trim();
  const configuredTimeout = environment.MODEL_GATEWAY_TIMEOUT_MS?.trim();
  const timeoutMs = configuredTimeout ? Number.parseInt(configuredTimeout, 10) : undefined;
  if (!url) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('MODEL_GATEWAY_URL is required for the production AI worker');
    }
    return unavailableOpenAssessmentModelGateway;
  }
  if (!token && environment.NODE_ENV === 'production') {
    throw new Error('MODEL_GATEWAY_TOKEN is required for the production AI worker');
  }
  if (
    configuredTimeout &&
    (!Number.isInteger(timeoutMs) ||
      timeoutMs === undefined ||
      timeoutMs < 1 ||
      timeoutMs > 120_000)
  ) {
    throw new Error('MODEL_GATEWAY_TIMEOUT_MS must be an integer between 1 and 120000');
  }
  return new HttpOpenAssessmentModelGateway({
    ...(token ? { authorizationToken: token } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    url,
  });
}

export type FixedModelOutcome =
  { candidate: GeneratedLearningPackCandidate; provider?: string } | { error: Error };

export class FixedModelGateway implements ModelGatewayPort {
  readonly tasks: ModelTask[] = [];
  #cursor = 0;

  constructor(private readonly outcomes: readonly FixedModelOutcome[]) {
    if (outcomes.length === 0) throw new Error('At least one fixed model outcome is required');
  }

  async runStructured(task: ModelTask): Promise<ModelTaskResult> {
    this.tasks.push(structuredClone(task));
    const outcome = this.outcomes[Math.min(this.#cursor, this.outcomes.length - 1)]!;
    this.#cursor += 1;
    if ('error' in outcome) throw outcome.error;
    return {
      candidate: structuredClone(outcome.candidate),
      externalTraceId: `fixed-trace-${this.#cursor}`,
      inputTokens: 120,
      outputTokens: 240,
      provider: outcome.provider ?? 'fixed-test-model',
    };
  }
}

export const unavailableModelGateway: ModelGatewayPort = {
  async runStructured() {
    throw new Error('MODEL_CAPABILITY_UNAVAILABLE');
  },
};

export const unavailableOpenAssessmentModelGateway: OpenAssessmentModelGatewayPort = {
  async runStructured() {
    throw new Error('MODEL_CAPABILITY_UNAVAILABLE');
  },
};
