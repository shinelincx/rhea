import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import {
  AssessmentError,
  type AssessmentActorReference,
  type AssessmentDisputeTarget,
} from '@rhea/assessment';
import { FamilyAccessError, type Actor } from '@rhea/family-access';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import { ASSESSMENT_SERVICE, type AssessmentService } from './assessment.provider.js';

const DISPUTE_TARGETS = new Set<AssessmentDisputeTarget>(['assessment', 'question', 'response']);

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssessmentError('INPUT_INVALID', `${label}格式不正确`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AssessmentError('INPUT_INVALID', `${label}必须是文本`);
  }
  return value;
}

function actorReference(actor: Actor): AssessmentActorReference {
  return actor.type === 'guardian'
    ? { id: actor.guardianId, type: 'guardian' }
    : { id: actor.learningProfileId, type: 'learner' };
}

function inputReference(value: unknown) {
  const body = recordValue(value, '已确认批改输入');
  return {
    confirmedContentVersionId: stringValue(body.confirmedContentVersionId, '已确认内容版本'),
    processingJobId: stringValue(body.processingJobId, '识别任务'),
    questionRegionId: stringValue(body.questionRegionId, '题目区域'),
    responseRegionId: stringValue(body.responseRegionId, '作答区域'),
  };
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class AssessmentController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(ASSESSMENT_SERVICE) private readonly assessments: AssessmentService,
  ) {}

  @Post('objective-assessments')
  async grade(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.assessments.gradeObjective({
        actor: actorReference(actor),
        familySpaceId,
        inputReference: inputReference(body.inputReference),
        learningProfileId,
        materialId: stringValue(body.materialId, '学习资料'),
      }),
    };
  }

  @Get('objective-assessments/:assessmentId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('assessmentId') assessmentId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return {
      data: await this.assessments.getAssessment({
        actor: actorReference(actor),
        assessmentId,
        learningProfileId,
      }),
    };
  }

  @Get('objective-assessments/:assessmentId/downstream-reference')
  async downstreamReference(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('assessmentId') assessmentId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return {
      data: await this.assessments.getDownstreamReference({
        actor: actorReference(actor),
        assessmentId,
        learningProfileId,
      }),
    };
  }

  @Post('objective-assessments/:assessmentId/disputes')
  async dispute(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('assessmentId') assessmentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    const target = stringValue(body.target, '质疑对象') as AssessmentDisputeTarget;
    if (!DISPUTE_TARGETS.has(target)) {
      throw new AssessmentError('INPUT_INVALID', '质疑对象必须是题目、作答或批改结论');
    }
    return {
      data: await this.assessments.raiseDispute({
        actor: actorReference(actor),
        assessmentId,
        correctionText: stringValue(body.correctionText, '补充修正信息'),
        learningProfileId,
        reason: stringValue(body.reason, '质疑原因'),
        target,
      }),
    };
  }

  @Post('objective-assessments/:assessmentId/disputes/:disputeId/resolution')
  async resolve(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('assessmentId') assessmentId: string,
    @Param('disputeId') disputeId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.assessments.resolveDispute({
        actor: actorReference(actor),
        assessmentId,
        disputeId,
        ...(body.inputReference === undefined
          ? {}
          : { inputReference: inputReference(body.inputReference) }),
        learningProfileId,
        reason: stringValue(body.reason, '解决说明'),
      }),
    };
  }

  private async authorize(
    authorization: string | undefined,
    familySpaceId: string,
    learningProfileId: string,
    mode: 'read' | 'submit' = 'submit',
  ): Promise<Actor> {
    return this.familyAccess.authorizeLearningProfile({
      accessToken: bearerToken(authorization),
      capability: mode === 'read' ? 'learning.read' : 'learning.submit',
      familySpaceId,
      learningProfileId,
    });
  }
}
