import type { SafetyEscalationStore } from './store.js';
import type { SafetyCaseQueueItem, SafetyCaseRecord, SupportAccessGrant } from './types.js';

export class MemorySafetyEscalationStore implements SafetyEscalationStore {
  readonly classifications: Array<
    Parameters<SafetyEscalationStore['recordClassification']>[0]['classification']
  > = [];
  readonly cases = new Map<string, SafetyCaseRecord>();
  readonly caseNotifications = new Map<
    string,
    Pick<SafetyCaseQueueItem, 'notificationId' | 'notificationStatus'>
  >();
  readonly grants = new Map<string, SupportAccessGrant>();
  readonly supportAudit: Array<Parameters<SafetyEscalationStore['appendSupportAudit']>[0]> = [];
  readonly caseOperations: Array<
    Parameters<SafetyEscalationStore['operateCase']>[0] & { applied: boolean }
  > = [];
  readonly caseQueueAccesses: Array<{
    caseIds: string[];
    occurredAt: string;
    operatorId: string;
    reason: string;
  }> = [];

  async appendSupportAudit(input: Parameters<SafetyEscalationStore['appendSupportAudit']>[0]) {
    this.supportAudit.push(structuredClone(input));
  }
  async recordClassification(input: Parameters<SafetyEscalationStore['recordClassification']>[0]) {
    this.classifications.push(structuredClone(input.classification));
    if (input.safetyCase) {
      this.cases.set(input.safetyCase.id, structuredClone(input.safetyCase));
      this.caseNotifications.set(input.safetyCase.id, {
        notificationId: this.caseNotifications.size + 1,
        notificationStatus: 'pending',
      });
    }
  }
  async createGrant(grant: SupportAccessGrant) {
    this.grants.set(grant.id, structuredClone(grant));
  }
  async findGrant(id: string) {
    return structuredClone(this.grants.get(id) ?? null);
  }
  async listActionableCases(operatorId: string, limit: number, reason: string, occurredAt: string) {
    const items = [...this.cases.values()]
      .filter(
        (item) =>
          ['open', 'pending_retry'].includes(item.status) &&
          (!item.assignedOperatorId ||
            item.assignedOperatorId === operatorId ||
            (item.claimExpiresAt !== null && item.claimExpiresAt <= occurredAt)),
      )
      .sort((left, right) =>
        left.severity === right.severity
          ? left.createdAt.localeCompare(right.createdAt)
          : left.severity === 'critical'
            ? -1
            : 1,
      )
      .slice(0, limit)
      .map((item) => ({
        ...item,
        ...(this.caseNotifications.get(item.id) ?? {
          notificationId: 0,
          notificationStatus: 'acknowledged' as const,
        }),
      }));
    this.caseQueueAccesses.push({
      caseIds: items.map(({ id }) => id),
      occurredAt,
      operatorId,
      reason,
    });
    return structuredClone(items);
  }
  async revokeGrant(input: {
    familySpaceId: string;
    grantId: string;
    guardianId: string;
    revokedAt: string;
  }) {
    const grant = this.grants.get(input.grantId);
    if (
      !grant ||
      grant.familySpaceId !== input.familySpaceId ||
      grant.createdByGuardianId !== input.guardianId ||
      grant.revokedAt
    )
      return false;
    this.grants.set(input.grantId, { ...grant, revokedAt: input.revokedAt });
    return true;
  }
  async operateCase(input: Parameters<SafetyEscalationStore['operateCase']>[0]) {
    const replay = this.caseOperations.find(({ commandId }) => commandId === input.commandId);
    if (replay) {
      const { applied: _applied, occurredAt: _recordedAt, ...original } = replay;
      const { occurredAt: _retriedAt, ...retried } = input;
      if (JSON.stringify(original) !== JSON.stringify(retried))
        throw new Error('安全个案幂等命令冲突');
      return replay.applied;
    }
    const record = this.cases.get(input.caseId);
    const leaseIsActive = Boolean(
      record?.claimExpiresAt && record.claimExpiresAt > input.occurredAt,
    );
    const applied = Boolean(
      record &&
      ((input.action === 'claim' &&
        ['open', 'pending_retry'].includes(record.status) &&
        (!record.assignedOperatorId ||
          record.assignedOperatorId === input.operatorId ||
          !leaseIsActive)) ||
        (input.action === 'release' &&
          record.assignedOperatorId === input.operatorId &&
          leaseIsActive &&
          ['open', 'pending_retry'].includes(record.status)) ||
        (input.action === 'escalation_failed' &&
          record.assignedOperatorId === input.operatorId &&
          leaseIsActive &&
          ['open', 'pending_retry'].includes(record.status)) ||
        (input.action === 'retry_started' &&
          record.assignedOperatorId === input.operatorId &&
          leaseIsActive &&
          record.status === 'pending_retry') ||
        (['false_positive', 'resolved'].includes(input.action) &&
          record.assignedOperatorId === input.operatorId &&
          leaseIsActive &&
          ['open', 'pending_retry'].includes(record.status))),
    );
    this.caseOperations.push({ ...structuredClone(input), applied });
    if (!record || !applied) return false;
    const status: SafetyCaseRecord['status'] =
      input.action === 'claim'
        ? record.status
        : input.action === 'release'
          ? record.status
          : input.action === 'escalation_failed'
            ? 'pending_retry'
            : input.action === 'retry_started'
              ? 'open'
              : input.action === 'false_positive'
                ? 'closed_false_positive'
                : 'resolved';
    this.cases.set(input.caseId, {
      ...record,
      assignedOperatorId:
        input.action === 'claim'
          ? input.operatorId
          : input.action === 'release'
            ? null
            : record.assignedOperatorId,
      claimedAt:
        input.action === 'claim'
          ? input.occurredAt
          : input.action === 'release'
            ? null
            : record.claimedAt,
      claimExpiresAt:
        input.action === 'claim'
          ? new Date(Date.parse(input.occurredAt) + 10 * 60_000).toISOString()
          : ['release', 'false_positive', 'resolved'].includes(input.action)
            ? null
            : record.claimExpiresAt,
      retryCount: input.action === 'escalation_failed' ? record.retryCount + 1 : record.retryCount,
      status,
      updatedAt: input.occurredAt,
    });
    if (input.action === 'claim') {
      const notification = this.caseNotifications.get(input.caseId);
      if (notification)
        this.caseNotifications.set(input.caseId, {
          ...notification,
          notificationStatus: 'acknowledged',
        });
    }
    if (input.action === 'release') {
      const notification = this.caseNotifications.get(input.caseId);
      if (notification)
        this.caseNotifications.set(input.caseId, {
          ...notification,
          notificationStatus: 'pending',
        });
    }
    return true;
  }
}
