import type { MetricsGovernanceService } from '@rhea/metrics-governance';
import type { SafetyEscalationService } from '@rhea/safety-escalation';
import type { QualityControlService } from '@rhea/quality-control';

export const METRICS_GOVERNANCE_SERVICE = Symbol('METRICS_GOVERNANCE_SERVICE');
export const QUALITY_CONTROL_OPERATIONS_SERVICE = Symbol('QUALITY_CONTROL_OPERATIONS_SERVICE');
export const SAFETY_OPERATIONS_SERVICE = Symbol('SAFETY_OPERATIONS_SERVICE');

export type SafetyOperationsService = SafetyEscalationService & {
  resolveChallengeReportSubjects?: (input: {
    occurredAt: string;
    operatorId: string;
    reason: string;
    reportId: string;
  }) => Promise<
    Array<{
      familySpaceId: string;
      learningProfileId: string;
      mappingRole: 'participant' | 'reporter';
      subjectToken: string;
    }>
  >;
};

export type { MetricsGovernanceService, QualityControlService };
