import type {
  SafetyCaseRecord,
  SafetyCaseQueueItem,
  SafetyClassificationInput,
  SafetyClassificationView,
  SafetySource,
  SupportAccessGrant,
  SupportAccessScope,
} from './types.js';

export interface MinimalSafetyClassificationRecord {
  action: SafetyClassificationView['action'];
  ageBand: SafetyCaseRecord['ageBand'];
  category: SafetyClassificationView['category'];
  createdAt: string;
  familySpaceId: string;
  id: string;
  learningProfileId: string;
  severity: SafetyClassificationView['severity'];
  source: SafetySource;
  sourceHash: string;
  sourceReferenceId: string;
}

export interface SafetyEscalationStore {
  appendSupportAudit(input: {
    action: string;
    allowed: boolean;
    grantId: string;
    occurredAt: string;
    recordId: string | null;
    scope: SupportAccessScope;
    supportPrincipalId: string;
  }): Promise<void>;
  recordClassification(input: {
    classification: MinimalSafetyClassificationRecord;
    safetyCase: SafetyCaseRecord | null;
  }): Promise<void>;
  createGrant(grant: SupportAccessGrant): Promise<void>;
  findGrant(id: string): Promise<SupportAccessGrant | null>;
  listActionableCases(
    operatorId: string,
    limit: number,
    reason: string,
    occurredAt: string,
  ): Promise<SafetyCaseQueueItem[]>;
  revokeGrant(input: {
    familySpaceId: string;
    grantId: string;
    guardianId: string;
    revokedAt: string;
  }): Promise<boolean>;
  operateCase(input: {
    action: import('./types.js').SafetyCaseOperationAction;
    caseId: string;
    commandId: string;
    occurredAt: string;
    operatorId: string;
    reason: string;
  }): Promise<boolean>;
}

void ({} as SafetyClassificationInput);
