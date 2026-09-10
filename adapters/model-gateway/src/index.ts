import type {
  GeneratedLearningPackCandidate,
  ModelGatewayPort,
  ModelTask,
  ModelTaskResult,
} from '@rhea/generated-learning';

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
