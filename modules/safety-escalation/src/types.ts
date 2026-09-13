export type SafetySource = 'ai_input' | 'ai_output' | 'challenge_event';
export type SafetyCategory =
  | 'abuse_or_neglect'
  | 'dangerous_instruction'
  | 'identifying_information'
  | 'none'
  | 'self_harm'
  | 'sexual_content'
  | 'unsafe_contact';
export type SafetySeverity = 'critical' | 'high' | 'low' | 'medium' | 'none';
export type SafetyCaseStatus = 'closed_false_positive' | 'open' | 'pending_retry' | 'resolved';
export type SafetyCaseOperationAction =
  'claim' | 'escalation_failed' | 'false_positive' | 'release' | 'resolved' | 'retry_started';
export type SupportAccessScope =
  'learning_summary' | 'processing_status' | 'specified_record' | 'technical_metadata';
export type SafetyAgeBand = 'lower_primary' | 'middle_primary' | 'upper_primary';

export interface SafetyClassificationInput {
  ageBand?: SafetyAgeBand;
  content: string;
  familySpaceId: string;
  guardianMayBeInvolved?: boolean;
  learningProfileId: string;
  source: SafetySource;
  sourceReferenceId: string;
}

export interface SafetyClassificationView {
  action: 'allow' | 'block_and_guide' | 'escalate';
  caseId: string | null;
  category: SafetyCategory;
  classificationId: string;
  guardianNotification:
    'manual_safety_review' | 'not_applicable' | 'suppressed_guardian_may_be_involved';
  guidance: string | null;
  severity: SafetySeverity;
}

export interface SafetyCaseRecord {
  ageBand: SafetyAgeBand;
  assignedOperatorId: string | null;
  category: Exclude<SafetyCategory, 'none'>;
  classificationId: string;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  createdAt: string;
  familySpaceId: string;
  guardianMayBeInvolved: boolean;
  id: string;
  learningProfileId: string;
  retryCount: number;
  severity: Exclude<SafetySeverity, 'none'>;
  source: SafetySource;
  sourceHash: string;
  sourceReferenceId: string;
  status: SafetyCaseStatus;
  updatedAt: string;
}
export interface SafetyCaseQueueItem extends SafetyCaseRecord {
  notificationId: number;
  notificationStatus: 'acknowledged' | 'pending';
}

export interface SupportAccessGrant {
  allowedRecordIds: string[];
  createdAt: string;
  createdByGuardianId: string;
  expiresAt: string;
  familySpaceId: string;
  id: string;
  learningProfileId: string;
  reason: string;
  revokedAt: string | null;
  scopes: SupportAccessScope[];
  supportPrincipalId: string;
}

export interface SupportAccessDecision {
  allowed: boolean;
  grant: SupportAccessGrant | null;
  reason:
    'allowed' | 'expired' | 'not_found' | 'record_not_allowed' | 'revoked' | 'scope_not_allowed';
}
