export type AcceptanceEvidenceKey =
  | 'child_safety'
  | 'disaster_recovery'
  | 'erasure'
  | 'failure_dispute'
  | 'failure_late_result'
  | 'failure_network_recovery'
  | 'failure_provider_degradation'
  | 'failure_source_invalidation'
  | 'mobile_core_flow'
  | 'performance_capacity'
  | 'quality_ai_ocr'
  | 'random_challenge_safety'
  | 'shanghai_compliance_package'
  | 'subject_chinese'
  | 'subject_english'
  | 'subject_mathematics'
  | 'subject_science';
export interface AcceptanceEvidence {
  capturedAt: string;
  details: string;
  key: AcceptanceEvidenceKey;
  owner: string;
  reference: string;
  status: 'failed' | 'not_run' | 'passed' | 'not_signed';
}
export interface AcceptanceReport {
  conclusion:
    'development_incomplete' | 'development_complete_pilot_blocked' | 'family_pilot_ready';
  developmentComplete: boolean;
  familyPilotReady: boolean;
  generatedAt: string;
  missingForDevelopment: AcceptanceEvidenceKey[];
  missingForPilot: AcceptanceEvidenceKey[];
  publicRelease: { allowed: false; reason: string };
  remainingRisks: Array<{
    deadline: string;
    evidenceKey: AcceptanceEvidenceKey;
    owner: string;
    status: AcceptanceEvidence['status'];
  }>;
  reportVersion: 'rhea-v1-acceptance-report-v1';
}
