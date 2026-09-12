import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import type { AssessmentActorReference } from '@rhea/assessment';
import { FamilyAccessError, type Actor } from '@rhea/family-access';
import { LearningProgressError } from '@rhea/learning-progress';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import {
  LEARNING_PROGRESS_SERVICE,
  type LearningProgressService,
} from './learning-progress.provider.js';
import {
  classificationStatus,
  masteryStatus,
  nullableString,
  optionalString,
  optionalSubject,
  reasonAction,
  reasonCategory,
  stateRevision,
  stringArray,
  stringValue,
  subject,
} from './learning-progress-request.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

function actorReference(actor: Actor): AssessmentActorReference {
  return actor.type === 'guardian'
    ? { id: actor.guardianId, type: 'guardian' }
    : { id: actor.learningProfileId, type: 'learner' };
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId/wrong-items')
export class LearningProgressController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(LEARNING_PROGRESS_SERVICE)
    private readonly learningProgress: LearningProgressService,
  ) {}

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    const parsedClassificationStatus = classificationStatus(query.classificationStatus);
    const parsedKnowledgePointName = optionalString(query.knowledgePointName, '知识点');
    const parsedMasteryStatus = masteryStatus(query.masteryStatus);
    const parsedSubject = optionalSubject(query.subject);
    const parsedUnitName = optionalString(query.unitName, '学习单元');
    const filter = {
      ...(parsedClassificationStatus === undefined
        ? {}
        : { classificationStatus: parsedClassificationStatus }),
      ...(parsedKnowledgePointName === undefined
        ? {}
        : { knowledgePointName: parsedKnowledgePointName }),
      ...(parsedMasteryStatus === undefined ? {} : { masteryStatus: parsedMasteryStatus }),
      ...(parsedSubject === undefined ? {} : { subject: parsedSubject }),
      ...(parsedUnitName === undefined ? {} : { unitName: parsedUnitName }),
    };
    return {
      data: await this.learningProgress.listWrongItems({
        actor: actorReference(actor),
        filter,
        learningProfileId,
      }),
    };
  }

  @Get('themes/:themeId/mastery')
  async getThemeMastery(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('themeId') themeId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return {
      data: await this.learningProgress.getWrongItemThemeMastery({
        actor: actorReference(actor),
        learningProfileId,
        themeId,
      }),
    };
  }

  @Get(':wrongItemId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('wrongItemId') wrongItemId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return {
      data: await this.learningProgress.getWrongItem({
        actor: actorReference(actor),
        learningProfileId,
        wrongItemId,
      }),
    };
  }

  @Post(':wrongItemId/reason-revisions')
  async reviseReason(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('wrongItemId') wrongItemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.learningProgress.reviseReason({
        action: reasonAction(body.action),
        actor: actorReference(actor),
        ...(body.category === undefined ? {} : { category: reasonCategory(body.category) }),
        expectedStateRevision: stateRevision(body.expectedStateRevision),
        ...(body.explanation === undefined
          ? {}
          : { explanation: stringValue(body.explanation, '错因说明') }),
        learningProfileId,
        ...(body.reason === undefined ? {} : { reason: stringValue(body.reason, '修正说明') }),
        wrongItemId,
      }),
    };
  }

  @Post(':wrongItemId/classification-revisions')
  async reviseClassification(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('wrongItemId') wrongItemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.learningProgress.reviseClassification({
        actor: actorReference(actor),
        expectedStateRevision: stateRevision(body.expectedStateRevision),
        knowledgePointNames: stringArray(body.knowledgePointNames, '知识点'),
        learningProfileId,
        primaryKnowledgePointName: nullableString(body.primaryKnowledgePointName, '主要知识点'),
        subject: subject(body.subject),
        unitName: nullableString(body.unitName, '学习单元'),
        wrongItemId,
      }),
    };
  }

  @Post(':wrongItemId/immediate-corrections')
  async submitImmediateCorrection(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('wrongItemId') wrongItemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    if (!idempotencyKey) {
      throw new LearningProgressError(
        'IDEMPOTENCY_KEY_REQUIRED',
        '即时订正必须提供 Idempotency-Key',
      );
    }
    return {
      data: await this.learningProgress.submitImmediateCorrection({
        actor: actorReference(actor),
        expectedStateRevision: stateRevision(body.expectedStateRevision),
        idempotencyKey,
        learningProfileId,
        responseText: stringValue(body.responseText, '订正作答'),
        wrongItemId,
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
