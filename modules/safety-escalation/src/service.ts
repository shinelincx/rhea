import { createHash, randomUUID } from 'node:crypto';

import { SafetyEscalationError } from './error.js';
import type { SafetyEscalationStore } from './store.js';
import type {
  SafetyCategory,
  SafetyClassificationInput,
  SafetyClassificationView,
  SafetyCaseRecord,
  SafetyCaseOperationAction,
  SafetySeverity,
  SupportAccessDecision,
  SupportAccessGrant,
  SupportAccessScope,
} from './types.js';

const SCOPES = new Set<SupportAccessScope>([
  'learning_summary',
  'processing_status',
  'specified_record',
  'technical_metadata',
]);
function guidance(ageBand: SafetyClassificationInput['ageBand']): string {
  if (ageBand === 'upper_primary') {
    return '先停下来并离开让你不舒服或有危险的情境，尽快告诉一位你信任且安全的成年人；如果眼前有人可能受伤，请联系当地紧急服务。AI 不能提供实时救援。';
  }
  if (ageBand === 'middle_primary') {
    return '先停下来，去找一位你信任、能保护你的成年人，把刚才的事情告诉他；如果眼前有人可能受伤，请联系当地紧急服务。AI 不能提供实时救援。';
  }
  return '先不要继续，马上去找一位你信任、能保护你的大人，把刚才的事情告诉他。AI 不能提供实时救援。';
}

function required(value: string, label: string, maximum = 500): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new SafetyEscalationError(
      'SAFETY_INPUT_INVALID',
      `${label}不能为空且不能超过 ${maximum} 个字符`,
    );
  }
  return normalized;
}
function uuid(value: string, label: string): string {
  const normalized = required(value, label, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
  ) {
    throw new SafetyEscalationError('SAFETY_INPUT_INVALID', `${label}无效`);
  }
  return normalized;
}

function classification(content: string): { category: SafetyCategory; severity: SafetySeverity } {
  const value = content.normalize('NFKC');
  if (/(自杀|不想活|伤害自己|割腕)/i.test(value))
    return { category: 'self_harm', severity: 'critical' };
  if (/(性侵|裸照|色情|性行为)/i.test(value))
    return { category: 'sexual_content', severity: 'high' };
  if (/(爸爸|妈妈|监护人).*(打|伤害|威胁)|虐待/i.test(value))
    return { category: 'abuse_or_neglect', severity: 'high' };
  if (/(加微信|私下联系|见面|地址|手机号|学校.*班)/i.test(value))
    return { category: 'unsafe_contact', severity: 'high' };
  if (/(炸弹|制毒|危险挑战|吞下|点燃)/i.test(value))
    return { category: 'dangerous_instruction', severity: 'high' };
  if (/(身份证|家庭住址|电话号码|真实姓名)/i.test(value))
    return { category: 'identifying_information', severity: 'medium' };
  return { category: 'none', severity: 'none' };
}

export class SafetyEscalationService {
  readonly #clock: { readonly now: Date };
  constructor(
    readonly store: SafetyEscalationStore,
    clock?: { readonly now: Date },
  ) {
    this.#clock = clock ?? {
      get now() {
        return new Date();
      },
    };
  }

  async classify(input: SafetyClassificationInput): Promise<SafetyClassificationView> {
    const content = required(input.content, '待分类内容', 20_000);
    const result = classification(content);
    const createdAt = this.#clock.now.toISOString();
    const classificationId = randomUUID();
    const sourceHash = createHash('sha256').update(content).digest('hex');
    const ageBand = input.ageBand ?? 'lower_primary';
    const action =
      result.severity === 'none'
        ? 'allow'
        : result.severity === 'medium'
          ? 'block_and_guide'
          : 'escalate';
    const classificationRecord = {
      action,
      ageBand,
      category: result.category,
      createdAt,
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      id: classificationId,
      learningProfileId: required(input.learningProfileId, '学习档案'),
      severity: result.severity,
      source: input.source,
      sourceHash,
      sourceReferenceId: required(input.sourceReferenceId, '来源引用'),
    } as const;
    let caseId: string | null = null;
    let safetyCase: SafetyCaseRecord | null = null;
    if (action === 'escalate' && result.category !== 'none' && result.severity !== 'none') {
      caseId = randomUUID();
      safetyCase = {
        ageBand,
        assignedOperatorId: null,
        category: result.category,
        classificationId,
        claimedAt: null,
        claimExpiresAt: null,
        createdAt,
        familySpaceId: input.familySpaceId,
        guardianMayBeInvolved: Boolean(input.guardianMayBeInvolved),
        id: caseId,
        learningProfileId: input.learningProfileId,
        retryCount: 0,
        severity: result.severity,
        source: input.source,
        sourceHash,
        sourceReferenceId: input.sourceReferenceId,
        status: 'open',
        updatedAt: createdAt,
      };
    }
    await this.store.recordClassification({ classification: classificationRecord, safetyCase });
    return {
      action,
      caseId,
      category: result.category,
      classificationId,
      guardianNotification:
        action !== 'escalate'
          ? 'not_applicable'
          : input.guardianMayBeInvolved
            ? 'suppressed_guardian_may_be_involved'
            : 'manual_safety_review',
      guidance: action === 'allow' ? null : guidance(ageBand),
      severity: result.severity,
    };
  }

  async grantSupportAccess(input: {
    allowedRecordIds?: string[];
    createdByGuardianId: string;
    durationMinutes: number;
    familySpaceId: string;
    learningProfileId: string;
    reason: string;
    scopes: SupportAccessScope[];
    supportPrincipalId: string;
  }): Promise<SupportAccessGrant> {
    if (
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < 5 ||
      input.durationMinutes > 480
    ) {
      throw new SafetyEscalationError(
        'SAFETY_INPUT_INVALID',
        '支持访问时长必须在 5 分钟到 8 小时之间',
      );
    }
    const scopes = [...new Set(input.scopes)];
    if (!scopes.length || scopes.some((scope) => !SCOPES.has(scope))) {
      throw new SafetyEscalationError('SAFETY_INPUT_INVALID', '支持访问范围无效');
    }
    const allowedRecordIds = [...new Set(input.allowedRecordIds ?? [])].map((id) =>
      required(id, '指定记录'),
    );
    if (scopes.includes('specified_record') && allowedRecordIds.length === 0) {
      throw new SafetyEscalationError('SAFETY_INPUT_INVALID', '指定记录访问必须列出记录标识');
    }
    const now = this.#clock.now;
    const grant: SupportAccessGrant = {
      allowedRecordIds,
      createdAt: now.toISOString(),
      createdByGuardianId: required(input.createdByGuardianId, '监护人'),
      expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000).toISOString(),
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      id: randomUUID(),
      learningProfileId: required(input.learningProfileId, '学习档案'),
      reason: required(input.reason, '支持原因'),
      revokedAt: null,
      scopes,
      supportPrincipalId: required(input.supportPrincipalId, '支持人员'),
    };
    await this.store.createGrant(grant);
    return grant;
  }

  async revokeSupportAccess(input: {
    familySpaceId: string;
    grantId: string;
    guardianId: string;
  }): Promise<void> {
    if (
      !(await this.store.revokeGrant({
        familySpaceId: required(input.familySpaceId, '家庭空间'),
        grantId: uuid(input.grantId, '支持授权'),
        guardianId: required(input.guardianId, '监护人'),
        revokedAt: this.#clock.now.toISOString(),
      }))
    ) {
      throw new SafetyEscalationError(
        'SUPPORT_GRANT_NOT_FOUND',
        '支持授权不存在、已撤销或不属于当前监护人',
      );
    }
  }

  async authorizeSupportOperation(input: {
    action: string;
    familySpaceId: string;
    grantId: string;
    recordId?: string;
    scope: SupportAccessScope;
    supportPrincipalId: string;
  }): Promise<SupportAccessDecision> {
    const familySpaceId = required(input.familySpaceId, '家庭空间');
    const supportPrincipalId = required(input.supportPrincipalId, '支持人员');
    const grantId = uuid(input.grantId, '支持授权');
    const grant = await this.store.findGrant(grantId);
    let reason: SupportAccessDecision['reason'] = 'allowed';
    if (
      !grant ||
      grant.familySpaceId !== familySpaceId ||
      grant.supportPrincipalId !== supportPrincipalId
    )
      reason = 'not_found';
    else if (grant.revokedAt) reason = 'revoked';
    else if (Date.parse(grant.expiresAt) <= this.#clock.now.getTime()) reason = 'expired';
    else if (!grant.scopes.includes(input.scope)) reason = 'scope_not_allowed';
    else if (
      input.scope === 'specified_record' &&
      (!input.recordId || !grant.allowedRecordIds.includes(input.recordId))
    )
      reason = 'record_not_allowed';
    await this.store.appendSupportAudit({
      action: required(input.action, '支持操作'),
      allowed: reason === 'allowed',
      grantId,
      occurredAt: this.#clock.now.toISOString(),
      recordId: input.recordId ?? null,
      scope: input.scope,
      supportPrincipalId,
    });
    return { allowed: reason === 'allowed', grant: reason === 'allowed' ? grant : null, reason };
  }

  async operateCase(input: {
    action: SafetyCaseOperationAction;
    caseId: string;
    commandId: string;
    operatorId: string;
    reason: string;
  }): Promise<void> {
    if (
      ![
        'claim',
        'escalation_failed',
        'false_positive',
        'release',
        'resolved',
        'retry_started',
      ].includes(input.action)
    ) {
      throw new SafetyEscalationError('SAFETY_INPUT_INVALID', '安全个案操作无效');
    }
    if (
      !(await this.store.operateCase({
        action: input.action,
        caseId: uuid(input.caseId, '安全个案'),
        commandId: uuid(input.commandId, '幂等命令'),
        occurredAt: this.#clock.now.toISOString(),
        operatorId: required(input.operatorId, '操作人员', 200),
        reason: required(input.reason, '操作原因', 500),
      }))
    ) {
      throw new SafetyEscalationError(
        'SAFETY_CASE_NOT_FOUND',
        '安全个案不存在或当前状态不允许该操作',
      );
    }
  }

  async listActionableCases(input: { limit?: number; operatorId: string; reason: string }) {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new SafetyEscalationError('SAFETY_INPUT_INVALID', '安全个案列表条数无效');
    return this.store.listActionableCases(
      required(input.operatorId, '操作人员', 200),
      limit,
      required(input.reason, '访问原因', 500),
      this.#clock.now.toISOString(),
    );
  }

  async markEscalationFailure(input: {
    caseId: string;
    commandId: string;
    operatorId: string;
    reason: string;
  }) {
    return this.operateCase({ ...input, action: 'escalation_failed' });
  }

  async retryEscalation(input: {
    caseId: string;
    commandId: string;
    operatorId: string;
    reason: string;
  }) {
    return this.operateCase({ ...input, action: 'retry_started' });
  }

  async resolveCase(input: {
    caseId: string;
    commandId: string;
    falsePositive: boolean;
    operatorId: string;
    reason: string;
  }) {
    return this.operateCase({
      action: input.falsePositive ? 'false_positive' : 'resolved',
      caseId: input.caseId,
      commandId: input.commandId,
      operatorId: input.operatorId,
      reason: input.reason,
    });
  }
}
