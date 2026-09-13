import { createHash, randomUUID } from 'node:crypto';
import type {
  OpenAssessmentModelGatewayPort,
  OpenAssessmentModelResult,
  OpenAssessmentModelTask,
} from '@rhea/assessment';
import type { IdentityProviderPort } from '@rhea/family-access';
import type { ModelGatewayPort, ModelTask, ModelTaskResult } from '@rhea/generated-learning';
import type {
  ReviewCardModelGatewayPort,
  ReviewCardModelResult,
  ReviewCardModelTask,
} from '@rhea/learning-progress';
import type {
  EgressRequest,
  ProviderDataCategory,
  ProviderGovernanceService,
} from '@rhea/provider-governance';
import type { SafetyEscalationService } from '@rhea/safety-escalation';
import type { RecognitionCandidate, RecognitionPort } from '@rhea/submission';

function hash(value: unknown) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PROVIDER_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
export interface GovernedHttpClientOptions {
  authorizationToken: string;
  capabilityVersionId: string;
  dataCategories: ProviderDataCategory[];
  governance: ProviderGovernanceService;
  purpose: string;
  timeoutMs?: number;
  url: string;
  deletionUrl?: string;
}
export class GovernedHttpClient {
  constructor(readonly options: GovernedHttpClientOptions) {}
  async post(payload: unknown): Promise<Record<string, unknown>> {
    return this.#postTo(this.options.url, payload);
  }
  async #postTo(
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const request: EgressRequest = {
      capabilityVersionId: this.options.capabilityVersionId,
      dataCategories: this.options.dataCategories,
      destinationUrl: url,
      payloadHash: hash(payload),
      purpose: this.options.purpose,
      requestId: randomUUID(),
    };
    const decision = await this.options.governance.authorize(request);
    if (!decision.allowed) throw new Error(`EGRESS_BLOCKED:${decision.reason}`);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          body: JSON.stringify(payload),
          headers: {
            authorization: `Bearer ${this.options.authorizationToken}`,
            'content-type': 'application/json',
            'x-rhea-request-id': request.requestId,
            ...headers,
          },
          method: 'POST',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
        if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
        const body = record(await response.json());
        await this.options.governance.record(request, {
          outcome: 'succeeded',
          providerId: decision.capability!.providerId,
          responseHash: hash(body),
        });
        return body;
      } catch (error) {
        lastError = error;
        if (attempt < 2 && !(error instanceof Error && error.message.startsWith('PROVIDER_HTTP_4')))
          continue;
        await this.options.governance.record(request, {
          outcome:
            error instanceof DOMException && error.name === 'TimeoutError' ? 'timed_out' : 'failed',
          providerId: decision.capability!.providerId,
          responseHash: null,
        });
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PROVIDER_UNAVAILABLE');
  }
  async delete(reference: string): Promise<{ receipt: string }> {
    if (!this.options.deletionUrl) throw new Error('PROVIDER_DELETE_URL_REQUIRED');
    const body = await this.#postTo(
      this.options.deletionUrl,
      { deletionHandle: reference },
      { 'idempotency-key': hash(`${this.options.capabilityVersionId}:${reference}`) },
    );
    const receipt = body.receipt;
    if (
      typeof receipt !== 'string' ||
      !receipt ||
      (body.status !== 'deleted' && body.status !== 'not_found')
    )
      throw new Error('PROVIDER_DELETE_RECEIPT_INVALID');
    return { receipt };
  }
}
function common(value: Record<string, unknown>) {
  if (typeof value.provider !== 'string') throw new Error('PROVIDER_RESPONSE_INVALID');
  return {
    candidate: record(value.candidate),
    externalTraceId: typeof value.externalTraceId === 'string' ? value.externalTraceId : null,
    inputTokens: typeof value.inputTokens === 'number' ? value.inputTokens : null,
    outputTokens: typeof value.outputTokens === 'number' ? value.outputTokens : null,
    provider: value.provider,
  };
}
type SafetyAwareModelTask = ModelTask | OpenAssessmentModelTask | ReviewCardModelTask;
interface ModelSafetyContext {
  ageBand: SafetyAwareModelTask['ageBand'];
  familySpaceId: string;
  learningProfileId: string;
  sourceReferenceId: string;
}

export class SafetyBlockedModelError extends Error {
  readonly code = 'SAFETY_BLOCKED';

  constructor(
    readonly guidance: string,
    readonly category: string,
  ) {
    super('SAFETY_BLOCKED');
    this.name = 'SafetyBlockedModelError';
  }
}

async function classifyModelContent(
  safety: SafetyEscalationService,
  safetyContext: ModelSafetyContext,
  content: unknown,
  source: 'ai_input' | 'ai_output',
): Promise<void> {
  const result = await safety.classify({
    ageBand: safetyContext.ageBand,
    content: JSON.stringify(content),
    familySpaceId: safetyContext.familySpaceId,
    learningProfileId: safetyContext.learningProfileId,
    source,
    sourceReferenceId:
      source === 'ai_input'
        ? safetyContext.sourceReferenceId
        : `${safetyContext.sourceReferenceId}:output`,
  });
  if (result.action !== 'allow') {
    throw new SafetyBlockedModelError(
      result.guidance ?? '请马上找一位你信任的成年人。',
      result.category,
    );
  }
}

async function runSafetyGovernedModel(
  http: GovernedHttpClient,
  safety: SafetyEscalationService,
  task: SafetyAwareModelTask,
  safetyContext: ModelSafetyContext,
): Promise<Record<string, unknown>> {
  await classifyModelContent(safety, safetyContext, task, 'ai_input');
  const response = await http.post({ task });
  await classifyModelContent(safety, safetyContext, response, 'ai_output');
  return response;
}

export class MainlandGeneratedLearningGateway implements ModelGatewayPort {
  constructor(
    readonly http: GovernedHttpClient,
    readonly safety: SafetyEscalationService,
  ) {}
  async runStructured(
    task: ModelTask,
    safetyContext: ModelSafetyContext,
  ): Promise<ModelTaskResult> {
    return common(
      await runSafetyGovernedModel(this.http, this.safety, task, safetyContext),
    ) as unknown as ModelTaskResult;
  }
}
export class MainlandOpenAssessmentGateway implements OpenAssessmentModelGatewayPort {
  constructor(
    readonly http: GovernedHttpClient,
    readonly safety: SafetyEscalationService,
  ) {}
  async runStructured(
    task: OpenAssessmentModelTask,
    safetyContext: ModelSafetyContext,
  ): Promise<OpenAssessmentModelResult> {
    return common(
      await runSafetyGovernedModel(this.http, this.safety, task, safetyContext),
    ) as unknown as OpenAssessmentModelResult;
  }
}
export class MainlandReviewCardGateway implements ReviewCardModelGatewayPort {
  constructor(
    readonly http: GovernedHttpClient,
    readonly safety: SafetyEscalationService,
  ) {}
  async runStructured(
    task: ReviewCardModelTask,
    safetyContext: ModelSafetyContext,
  ): Promise<ReviewCardModelResult> {
    return common(
      await runSafetyGovernedModel(this.http, this.safety, task, safetyContext),
    ) as unknown as ReviewCardModelResult;
  }
}
export class ShanghaiOcrRecognitionAdapter implements RecognitionPort {
  constructor(readonly http: GovernedHttpClient) {}
  async recognize(input: {
    authorization: RecognitionCandidate['authorization'];
    pages: Array<{ bytes: Uint8Array; page: { id: string; mimeType: string } }>;
    sourceHash: string;
  }) {
    let value: Record<string, unknown>;
    try {
      value = await this.http.post({
        authorizationDecisionId: input.authorization.decisionId,
        capabilityVersionId: input.authorization.capabilityVersion.id,
        pages: input.pages.map(({ bytes, page }) => ({
          bytesBase64: Buffer.from(bytes).toString('base64'),
          id: page.id,
          mimeType: page.mimeType,
        })),
        sourceHash: input.sourceHash,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PROVIDER_RESPONSE_INVALID') {
        throw new Error('OCR_RESPONSE_INVALID', { cause: error });
      }
      throw new Error('RECOGNITION_PROVIDER_UNAVAILABLE', { cause: error });
    }
    if (
      !Array.isArray(value.regions) ||
      typeof value.deletionHandle !== 'string' ||
      !value.deletionHandle
    )
      throw new Error('OCR_RESPONSE_INVALID');
    return {
      providerDeletionHandle: value.deletionHandle,
      regions: value.regions as RecognitionCandidate['regions'],
    };
  }
}
export class ShanghaiCiamIdentityProvider implements IdentityProviderPort {
  constructor(readonly http: GovernedHttpClient) {}
  async verify(identityAssertion: string) {
    const value = await this.http.post({ identityAssertion });
    if (typeof value.subject !== 'string' || !value.subject)
      throw new Error('CIAM_RESPONSE_INVALID');
    return { subject: value.subject };
  }
}
