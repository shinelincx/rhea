import type { ProviderGovernanceStore } from './store.js';
import type {
  EgressAuditRecord,
  EgressDecision,
  EgressRequest,
  ProviderCapability,
} from './types.js';
const CONTRACT_KEYS = [
  'dataRegionSigned',
  'deletionSlaSigned',
  'incidentNoticeSigned',
  'noTrainingSigned',
  'retentionSigned',
  'subprocessorsSigned',
  'supportAccessSigned',
  'exitMigrationSigned',
] as const;
const CAPABILITY_KEYS = [
  'allowedDataCategories',
  'allowedOrigins',
  'capabilityVersionId',
  'contract',
  'enabled',
  'kind',
  'providerId',
  'region',
] as const;
const DATA_CATEGORIES = [
  'authentication_assertion',
  'confirmed_structured_learning_data',
  'minimal_crop',
  'source_image',
] as const;
const PROVIDER_KINDS = ['ciam', 'llm', 'ocr'] as const;
const PROVIDER_REGIONS = ['cn-beijing', 'cn-mainland', 'cn-shanghai'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isProviderCapability(value: unknown): value is ProviderCapability {
  if (!isRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS)) return false;
  const contract = value.contract;
  return (
    typeof value.capabilityVersionId === 'string' &&
    value.capabilityVersionId.trim().length > 0 &&
    value.capabilityVersionId.length <= 200 &&
    typeof value.providerId === 'string' &&
    value.providerId.trim().length > 0 &&
    value.providerId.length <= 200 &&
    typeof value.enabled === 'boolean' &&
    PROVIDER_KINDS.some((kind) => kind === value.kind) &&
    PROVIDER_REGIONS.some((region) => region === value.region) &&
    Array.isArray(value.allowedOrigins) &&
    value.allowedOrigins.length > 0 &&
    value.allowedOrigins.every((origin) => typeof origin === 'string') &&
    Array.isArray(value.allowedDataCategories) &&
    value.allowedDataCategories.length > 0 &&
    value.allowedDataCategories.every(
      (category) =>
        typeof category === 'string' && DATA_CATEGORIES.some((allowed) => allowed === category),
    ) &&
    isRecord(contract) &&
    hasExactKeys(contract, CONTRACT_KEYS) &&
    CONTRACT_KEYS.every((key) => typeof contract[key] === 'boolean')
  );
}

export function assertProviderCapability(value: unknown): asserts value is ProviderCapability {
  if (!isProviderCapability(value)) throw new Error('PROVIDER_CAPABILITY_INVALID');
}

export class ProviderGovernanceService {
  constructor(
    readonly store: ProviderGovernanceStore,
    readonly clock: { readonly now: Date } = {
      get now() {
        return new Date();
      },
    },
  ) {}
  async authorize(request: EgressRequest): Promise<EgressDecision> {
    const storedCapability = await this.store.findCapability(request.capabilityVersionId);
    const capability = isProviderCapability(storedCapability) ? storedCapability : null;
    let reason: EgressDecision['reason'] = 'allowed';
    if (!storedCapability) reason = 'capability_not_found';
    else if (!capability) reason = 'capability_invalid';
    else if (!capability.enabled) reason = 'capability_disabled';
    else if (CONTRACT_KEYS.some((key) => capability.contract[key] !== true))
      reason = 'contract_incomplete';
    else {
      let origin: string;
      try {
        const url = new URL(request.destinationUrl);
        if (url.protocol !== 'https:') throw new Error();
        origin = url.origin;
      } catch {
        origin = '';
      }
      if (!origin || !capability.allowedOrigins.includes(origin)) reason = 'destination_denied';
      else if (
        request.dataCategories.some(
          (category) => !capability.allowedDataCategories.includes(category),
        )
      )
        reason = 'data_category_denied';
      else if (capability.kind === 'ocr' && capability.region !== 'cn-shanghai')
        reason = 'region_denied';
      else if (
        capability.kind === 'llm' &&
        !['cn-beijing', 'cn-mainland', 'cn-shanghai'].includes(capability.region)
      )
        reason = 'region_denied';
    }
    if (reason !== 'allowed')
      await this.record(request, {
        outcome: 'blocked',
        providerId: capability?.providerId ?? null,
        responseHash: null,
      });
    return {
      allowed: reason === 'allowed',
      capability: reason === 'allowed' ? capability : null,
      reason,
    };
  }
  async record(
    request: EgressRequest,
    result: Pick<EgressAuditRecord, 'outcome' | 'providerId' | 'responseHash'>,
  ) {
    const storedCapability = await this.store.findCapability(request.capabilityVersionId);
    const capability = isProviderCapability(storedCapability) ? storedCapability : null;
    let origin = 'invalid';
    try {
      origin = new URL(request.destinationUrl).origin;
    } catch {}
    await this.store.recordEgress({
      capabilityVersionId: request.capabilityVersionId,
      dataCategories: [...request.dataCategories],
      destinationOrigin: origin,
      finishedAt: this.clock.now.toISOString(),
      outcome: result.outcome,
      payloadHash: request.payloadHash,
      providerId: result.providerId,
      purpose: request.purpose,
      region: capability?.region ?? null,
      requestId: request.requestId,
      responseHash: result.responseHash,
    });
  }
  async registerCapability(capability: ProviderCapability) {
    assertProviderCapability(capability);
    if (
      !capability.allowedOrigins.length ||
      capability.allowedOrigins.some((origin) => {
        try {
          return new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:';
        } catch {
          return true;
        }
      })
    )
      throw new Error('供应商能力只能登记精确 HTTPS origin');
    if (capability.kind === 'ocr' && capability.region !== 'cn-shanghai')
      throw new Error('OCR 只能登记上海地域');
    await this.store.saveCapability(structuredClone(capability));
  }
}
