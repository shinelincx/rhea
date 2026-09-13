import type { ProviderGovernanceStore } from './store.js';
import type { EgressAuditRecord, ProviderCapability } from './types.js';
import { providerCapabilitiesEqual } from './equality.js';
export class MemoryProviderGovernanceStore implements ProviderGovernanceStore {
  readonly capabilities = new Map<string, ProviderCapability>();
  readonly audits: EgressAuditRecord[] = [];
  constructor(seed: ProviderCapability[] = []) {
    seed.forEach((value) =>
      this.capabilities.set(value.capabilityVersionId, structuredClone(value)),
    );
  }
  async findCapability(id: string) {
    return structuredClone(this.capabilities.get(id) ?? null);
  }
  async recordEgress(value: EgressAuditRecord) {
    this.audits.push(structuredClone(value));
  }
  async saveCapability(value: ProviderCapability) {
    const existing = this.capabilities.get(value.capabilityVersionId);
    if (existing && !providerCapabilitiesEqual(existing, value)) {
      throw new Error('PROVIDER_CAPABILITY_VERSION_CONFLICT');
    }
    if (!existing) this.capabilities.set(value.capabilityVersionId, structuredClone(value));
  }
}
