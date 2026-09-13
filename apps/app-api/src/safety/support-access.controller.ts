import { createHash, timingSafeEqual } from 'node:crypto';

import { Body, Controller, Delete, Headers, Inject, Param, Post } from '@nestjs/common';
import { FamilyAccessError, type FamilyAccess } from '@rhea/family-access';
import { SafetyEscalationError, type SupportAccessScope } from '@rhea/safety-escalation';

import { FAMILY_ACCESS } from '../family-access/family-access.provider.js';
import { SAFETY_ESCALATION_SERVICE, type SafetyEscalationService } from './safety.provider.js';
import { SUPPORT_DATA_READER, type SupportDataReader } from './support-data.provider.js';

function bearerToken(value: string | undefined): string {
  if (!value?.startsWith('Bearer ') || value.length <= 7)
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  return value.slice(7);
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
const SUPPORT_SCOPES = new Set<SupportAccessScope>([
  'learning_summary',
  'processing_status',
  'specified_record',
  'technical_metadata',
]);
function supportTokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}
function supportPrincipalToken(principalId: string): string | undefined {
  const configured = process.env.SUPPORT_PRINCIPAL_TOKENS;
  if (configured) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configured);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[principalId];
    return typeof value === 'string' && value.length >= 24 ? value : undefined;
  }
  return process.env.NODE_ENV === 'production' ? undefined : process.env.SUPPORT_SERVICE_TOKEN;
}

@Controller('v1/family-spaces/:familySpaceId')
export class SupportAccessController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(SAFETY_ESCALATION_SERVICE) private readonly safety: SafetyEscalationService,
    @Inject(SUPPORT_DATA_READER) private readonly supportData: SupportDataReader,
  ) {}

  @Post('learning-profiles/:learningProfileId/support-access-grants')
  async grant(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body()
    body: {
      allowedRecordIds?: unknown;
      durationMinutes?: unknown;
      reason?: unknown;
      scopes?: unknown;
      supportPrincipalId?: unknown;
    },
  ) {
    const accessToken = bearerToken(authorization);
    const guardian = await this.familyAccess.authorizeSensitive({
      accessToken,
      capability: 'support_access.manage',
      familySpaceId,
    });
    await this.familyAccess.getLearningProfile({
      accessToken,
      familySpaceId,
      learningProfileId,
    });
    return {
      data: await this.safety.grantSupportAccess({
        allowedRecordIds: Array.isArray(body.allowedRecordIds)
          ? body.allowedRecordIds.filter((value): value is string => typeof value === 'string')
          : [],
        createdByGuardianId: guardian.guardianId,
        durationMinutes: typeof body.durationMinutes === 'number' ? body.durationMinutes : 0,
        familySpaceId,
        learningProfileId,
        reason: text(body.reason),
        scopes: Array.isArray(body.scopes)
          ? body.scopes.filter((value): value is SupportAccessScope => typeof value === 'string')
          : [],
        supportPrincipalId: text(body.supportPrincipalId),
      }),
    };
  }

  @Delete('support-access-grants/:grantId')
  async revoke(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('grantId') grantId: string,
  ) {
    const guardian = await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'support_access.manage',
      familySpaceId,
    });
    await this.safety.revokeSupportAccess({
      familySpaceId,
      grantId,
      guardianId: guardian.guardianId,
    });
    return { data: { grantId, status: 'revoked' } };
  }

  @Post('support-access-grants/:grantId/operations')
  async authorizeOperation(
    @Headers('x-rhea-support-token') supportToken: string | undefined,
    @Headers('x-rhea-support-principal') supportPrincipalId: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('grantId') grantId: string,
    @Body() body: { action?: unknown; recordId?: unknown; scope?: unknown },
  ) {
    const expectedToken = supportPrincipalId
      ? supportPrincipalToken(supportPrincipalId)
      : undefined;
    if (
      !expectedToken ||
      !supportTokenMatches(supportToken, expectedToken) ||
      !supportPrincipalId
    ) {
      throw new FamilyAccessError('SESSION_INVALID', '支持人员身份验证失败');
    }
    const scope = text(body.scope) as SupportAccessScope;
    if (!SUPPORT_SCOPES.has(scope)) {
      throw new SafetyEscalationError('SAFETY_INPUT_INVALID', '支持访问范围无效');
    }
    const decision = await this.supportData.authorizeAndRead({
      action: text(body.action),
      familySpaceId,
      grantId,
      ...(typeof body.recordId === 'string' ? { recordId: body.recordId } : {}),
      scope,
      supportPrincipalId,
    });
    if (!decision.allowed) {
      throw new SafetyEscalationError(
        'SUPPORT_ACCESS_DENIED',
        `支持访问被拒绝：${decision.reason}`,
      );
    }
    return {
      data: {
        allowed: true,
        expiresAt: decision.expiresAt,
        familySpaceId: decision.familySpaceId,
        learningProfileId: decision.learningProfileId,
        record: decision.record,
        scope,
      },
    };
  }
}
