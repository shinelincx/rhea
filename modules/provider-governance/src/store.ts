import type { EgressAuditRecord, ProviderCapability } from './types.js';
export interface ProviderGovernanceStore {
  findCapability(id: string): Promise<ProviderCapability | null>;
  recordEgress(record: EgressAuditRecord): Promise<void>;
  saveCapability(capability: ProviderCapability): Promise<void>;
}
