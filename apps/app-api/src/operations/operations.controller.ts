import { createHash, timingSafeEqual } from 'node:crypto';

import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { ReadinessEvidence } from '@rhea/metrics-governance';
import type {
  AuthorizeCapabilityInput,
  CapabilityUseSlice,
  CapabilityVersion,
  EvaluationRun,
  RequiredSlicePolicy,
  RolloutStage,
  SignoffRole,
} from '@rhea/quality-control';
import { FamilyAccessError } from '@rhea/family-access';
import type { SafetyCaseOperationAction } from '@rhea/safety-escalation';

import {
  METRICS_GOVERNANCE_SERVICE,
  QUALITY_CONTROL_OPERATIONS_SERVICE,
  SAFETY_OPERATIONS_SERVICE,
  type MetricsGovernanceService,
  type QualityControlService,
  type SafetyOperationsService,
} from './operations.provider.js';
import { operationsCredential, type OperationsRole } from './operations-auth.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function number(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function authenticate(principalId: string | undefined, actualToken: string | undefined) {
  const credential = principalId ? operationsCredential(process.env, principalId) : null;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (
    !principalId ||
    !actualToken ||
    !credential ||
    !timingSafeEqual(digest(actualToken), digest(credential.token))
  ) {
    throw new FamilyAccessError('SESSION_INVALID', '运营人员身份验证失败');
  }
  return { actorId: principalId, role: credential.role };
}

function authorize(
  principalId: string | undefined,
  actualToken: string | undefined,
  allowedRoles: OperationsRole[],
) {
  const actor = authenticate(principalId, actualToken);
  if (!allowedRoles.includes(actor.role))
    throw new FamilyAccessError('SESSION_INVALID', '运营人员角色无权执行该操作');
  return actor;
}

@Controller('internal/operations')
export class OperationsController {
  constructor(
    @Inject(METRICS_GOVERNANCE_SERVICE) private readonly metrics: MetricsGovernanceService,
    @Inject(QUALITY_CONTROL_OPERATIONS_SERVICE) private readonly quality: QualityControlService,
    @Inject(SAFETY_OPERATIONS_SERVICE) private readonly safety: SafetyOperationsService,
  ) {}

  #actor(
    principal: string | undefined,
    token: string | undefined,
    reason: unknown,
    allowedRoles: OperationsRole[],
  ) {
    const actor = authorize(principal, token, allowedRoles);
    return { actorId: actor.actorId, reason: text(reason), role: actor.role };
  }

  @Get('safety-cases')
  async safetyCases(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Headers('x-rhea-operation-reason') reason: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const actor = authorize(principal, token, ['safety_operator']);
    return {
      data: await this.safety.listActionableCases({
        ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) }),
        operatorId: actor.actorId,
        reason: text(reason),
      }),
    };
  }

  @Post('safety-cases/:caseId/actions')
  async operateSafetyCase(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Headers('idempotency-key') commandId: string | undefined,
    @Param('caseId') caseId: string,
    @Body() body: { action?: unknown; reason?: unknown },
  ) {
    const actor = this.#actor(principal, token, body.reason, ['safety_operator']);
    const action = text(body.action) as SafetyCaseOperationAction;
    await this.safety.operateCase({
      action,
      caseId,
      commandId: text(commandId),
      operatorId: actor.actorId,
      reason: actor.reason,
    });
    return { data: { action, caseId, status: 'recorded' } };
  }

  @Get('safety-reports/:reportId/subjects')
  async resolveSafetyReportSubjects(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Headers('x-rhea-operation-reason') reason: string | undefined,
    @Param('reportId') reportId: string,
  ) {
    const actor = this.#actor(principal, token, reason, ['safety_operator']);
    if (!this.safety.resolveChallengeReportSubjects) {
      throw new Error('SAFETY_SUBJECT_MAPPING_RESOLUTION_UNAVAILABLE');
    }
    return {
      data: await this.safety.resolveChallengeReportSubjects({
        occurredAt: new Date().toISOString(),
        operatorId: actor.actorId,
        reason: actor.reason,
        reportId,
      }),
    };
  }

  @Post('metrics/definitions')
  async registerMetric(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const result = await this.metrics.registerMetric(
      {
        denominator: text(body.denominator),
        exclusions: stringList(body.exclusions),
        key: text(body.key),
        numerator: text(body.numerator),
        owner: text(body.owner),
        retentionDays: number(body.retentionDays),
        version: text(body.version),
        windowDays: number(body.windowDays),
      },
      this.#actor(principal, token, body.reason, ['metrics_operator']),
    );
    return { data: { outcome: result } };
  }

  @Post('provider-quality-readiness/evaluate')
  async evaluateProviderQualityReadiness(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return {
      data: await this.metrics.evaluateProviderQualityReadiness(
        this.#actor(principal, token, body.reason, ['release_manager']),
      ),
    };
  }

  @Post('quality-control/policies')
  async registerQualityPolicy(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, ['metrics_operator']);
    const policy = {
      ...record(body.policy),
      registeredAt: new Date().toISOString(),
    } as unknown as RequiredSlicePolicy;
    return {
      data: await this.quality.registerSlicePolicy({
        actorId: actor.actorId,
        commandId: text(body.commandId),
        policy,
        reason: actor.reason,
      }),
    };
  }

  @Post('quality-control/capabilities')
  async registerQualityCapability(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, ['metrics_operator']);
    const version = {
      ...record(body.version),
      implementedBy: actor.actorId,
      registeredAt: new Date().toISOString(),
    } as unknown as CapabilityVersion;
    return {
      data: await this.quality.registerCapability({
        actorId: actor.actorId,
        commandId: text(body.commandId),
        reason: actor.reason,
        version,
      }),
    };
  }

  @Post('quality-control/capabilities/:capabilityVersionId/evaluations')
  async recordQualityEvaluation(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, ['metrics_operator']);
    const run = {
      ...record(body.run),
      capabilityVersionId,
    } as unknown as EvaluationRun;
    return {
      data: await this.quality.recordEvaluation({
        actorId: actor.actorId,
        commandId: text(body.commandId),
        expectedRevision: number(body.expectedRevision),
        reason: actor.reason,
        run,
      }),
    };
  }

  @Put('quality-control/capabilities/:capabilityVersionId/signoffs')
  async signOffQualityCapability(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, [
      'child_safety',
      'compliance',
      'domain_reviewer',
      'quality_owner',
    ]);
    return {
      data: await this.quality.signOffCapability({
        actorId: actor.actorId,
        capabilityVersionId,
        commandId: text(body.commandId),
        evidenceHash: text(body.evidenceHash),
        expectedRevision: number(body.expectedRevision),
        policyVersion: text(body.policyVersion),
        reason: actor.reason,
        signedAt: new Date().toISOString(),
        signer: { id: actor.actorId, role: actor.role as SignoffRole },
      }),
    };
  }

  @Post('quality-control/capabilities/:capabilityVersionId/rollout')
  async advanceQualityRollout(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, ['release_manager']);
    return {
      data: await this.quality.advanceRollout({
        actorId: actor.actorId,
        allowedUseSlices: Array.isArray(body.allowedUseSlices)
          ? (body.allowedUseSlices as CapabilityUseSlice[])
          : [],
        capabilityVersionId,
        changedAt: new Date().toISOString(),
        commandId: text(body.commandId),
        expectedRevision: number(body.expectedRevision),
        percentage: number(body.percentage),
        reason: actor.reason,
        stage: text(body.stage) as RolloutStage,
      }),
    };
  }

  @Post('quality-control/capabilities/:capabilityVersionId/containment')
  async containQualityCapability(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, ['release_manager']);
    return {
      data: await this.quality.containCapability({
        actorId: actor.actorId,
        commandId: text(body.commandId),
        containedAt: text(body.containedAt),
        expectedContainmentEpoch: number(body.expectedContainmentEpoch),
        reason: actor.reason,
        target: { id: capabilityVersionId, kind: 'capability_version' },
      }),
    };
  }

  @Post('quality-control/capabilities/:capabilityVersionId/rollback')
  async rollbackQualityCapability(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = this.#actor(principal, token, body.reason, ['release_manager']);
    return {
      data: await this.quality.rollbackCapability({
        actorId: actor.actorId,
        authorization: record(body.authorization) as unknown as AuthorizeCapabilityInput,
        commandId: text(body.commandId),
        containedAt: text(body.containedAt),
        expectedContainmentEpoch: number(body.expectedContainmentEpoch),
        failedCapabilityVersionId: capabilityVersionId,
        reason: actor.reason,
      }),
    };
  }

  @Get('quality-control/capabilities/:capabilityVersionId')
  async qualityCapability(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
  ) {
    authenticate(principal, token);
    return { data: await this.quality.getCapability(capabilityVersionId) };
  }

  @Get('quality-control/capabilities/:capabilityVersionId/card')
  async qualityCard(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('capabilityVersionId') capabilityVersionId: string,
  ) {
    authenticate(principal, token);
    return { data: await this.quality.getQualityCard(capabilityVersionId) };
  }

  @Get('provider-quality-readiness')
  async providerQualityReadiness(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
  ) {
    authenticate(principal, token);
    return {
      data: await this.metrics.getProviderQualityReadiness(),
    };
  }

  @Put('readiness-evidence/:key')
  async recordReadiness(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
    @Param('key') key: ReadinessEvidence['key'],
    @Body() body: Record<string, unknown>,
  ) {
    await this.metrics.saveReadinessEvidence(
      {
        key,
        passed: body.passed === true,
        reference: text(body.reference),
        signedBy: null,
      },
      this.#actor(principal, token, body.reason, ['release_manager']),
    );
    return { data: { key, status: 'recorded' } };
  }

  @Get('readiness')
  async readiness(
    @Headers('x-rhea-operator-id') principal: string | undefined,
    @Headers('x-rhea-operator-token') token: string | undefined,
  ) {
    authenticate(principal, token);
    return { data: await this.metrics.getReadiness() };
  }
}
