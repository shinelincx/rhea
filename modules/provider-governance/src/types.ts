export type ProviderKind = 'ciam' | 'llm' | 'ocr';
export type ProviderDataCategory =
  | 'authentication_assertion'
  | 'confirmed_structured_learning_data'
  | 'minimal_crop'
  | 'source_image';
export interface ProviderCapability {
  allowedDataCategories: ProviderDataCategory[];
  allowedOrigins: string[];
  capabilityVersionId: string;
  contract: {
    dataRegionSigned: boolean;
    deletionSlaSigned: boolean;
    incidentNoticeSigned: boolean;
    noTrainingSigned: boolean;
    retentionSigned: boolean;
    subprocessorsSigned: boolean;
    supportAccessSigned: boolean;
    exitMigrationSigned: boolean;
  };
  enabled: boolean;
  kind: ProviderKind;
  providerId: string;
  region: 'cn-beijing' | 'cn-mainland' | 'cn-shanghai';
}
export interface EgressRequest {
  capabilityVersionId: string;
  dataCategories: ProviderDataCategory[];
  destinationUrl: string;
  payloadHash: string;
  purpose: string;
  requestId: string;
}
export interface EgressDecision {
  allowed: boolean;
  capability: ProviderCapability | null;
  reason:
    | 'allowed'
    | 'capability_invalid'
    | 'capability_disabled'
    | 'capability_not_found'
    | 'contract_incomplete'
    | 'data_category_denied'
    | 'destination_denied'
    | 'region_denied';
}
export interface EgressAuditRecord {
  capabilityVersionId: string;
  dataCategories: ProviderDataCategory[];
  destinationOrigin: string;
  finishedAt: string;
  outcome: 'blocked' | 'failed' | 'succeeded' | 'timed_out';
  payloadHash: string;
  providerId: string | null;
  purpose: string;
  region: ProviderCapability['region'] | null;
  requestId: string;
  responseHash: string | null;
}
