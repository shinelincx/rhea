import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import {
  AssessmentError,
  type AssessmentActorReference,
  type AssessmentDisputeTarget,
  type OpenAssessmentAgeBand,
} from '@rhea/assessment';
import { FamilyAccessError, type Actor, type Grade } from '@rhea/family-access';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import {
  ASSESSMENT_SERVICE,
  SUGGESTED_ASSESSMENT_SERVICE,
  type AssessmentService,
  type SuggestedAssessmentService,
} from './assessment.provider.js';
import {
  assessmentCorrection,
  assessmentInputReference,
  objectiveGradingRule,
  openAssessmentReviewDecisions,
  openAssessmentTaskType,
  stringValue,
} from './assessment-request.js';

const DISPUTE_TARGETS = new Set<AssessmentDisputeTarget>(['assessment', 'question', 'response']);

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

function ageBand(grade: Grade | null): OpenAssessmentAgeBand {
  if (grade === null || grade <= 2) return 'lower_primary';
  return grade <= 4 ? 'middle_primary' : 'upper_primary';
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class AssessmentController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(ASSESSMENT_SERVICE) private readonly assessments: AssessmentService,
    @Inject(SUGGESTED_ASSESSMENT_SERVICE)
    private readonly suggestedAssessments: SuggestedAssessmentService,
  ) {}

  @Post('open-assessment-suggestions')
  async suggestOpenAssessment(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const accessToken = bearerToken(authorization);
    const [actor, profile, consent] = await Promise.all([
      this.familyAccess.authorizeLearningProfile({
        accessToken,
        capability: 'learning.submit',
        familySpaceId,
        learningProfileId,
      }),
      this.familyAccess.getLearningProfile({ accessToken, familySpaceId, learningProfileId }),
      this.familyAccess.requireConsent({
        accessToken,
        familySpaceId,
        kind: 'ai_processing',
      }),
    ]);
    return {
      data: await this.suggestedAssessments.suggest({
        actor: actorReference(actor),
        ageBand: ageBand(profile.grade),
        consentRevision: consent.revision,
        familySpaceId,
        inputReference: assessmentInputReference(body.inputReference),
        learningProfileId,
        materialId: stringValue(body.materialId, '学习资料'),
        taskType: openAssessmentTaskType(body.taskType),
      }),
    };
  }

  @Get('open-assessment-suggestions/:suggestionId')
  async getOpenAssessmentSuggestion(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return {
      data: await this.suggestedAssessments.getSuggestion({
        actor: actorReference(actor),
        learningProfileId,
        suggestionId,
      }),
    };
  }

  @Post('open-assessment-suggestions/:suggestionId/review')
  async reviewOpenAssessmentSuggestion(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.suggestedAssessments.review({
        decisions: openAssessmentReviewDecisions(body.decisions),
        expectedStateRevision:
          typeof body.expectedStateRevision === 'number' ? body.expectedStateRevision : 0,
        learningProfileId,
        reviewer: actorReference(actor),
        suggestionId,
      }),
    };
  }

  @Get('open-assessment-suggestions/:suggestionId/downstream-reference')
  async openAssessmentDownstreamReference(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return {
      data: await this.suggestedAssessments.getAcceptedResultReference({
        actor: actorReference(actor),
        learningProfileId,
        suggestionId,
      }),
    };
  }

  @Post('objective-grading-rules')
  async confirmRule(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.assessments.confirmObjectiveRule({
        actor: actorReference(actor),
        familySpaceId,
        inputReference: assessmentInputReference(body.inputReference),
        learningProfileId,
        materialId: stringValue(body.materialId, '学习资料'),
        rule: objectiveGradingRule(body.rule),
      }),
    };
  }

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
        inputReference: assessmentInputReference(body.inputReference),
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
        ...(body.correction === undefined
          ? {}
          : { correction: assessmentCorrection(body.correction) }),
        disputeId,
        ...(body.inputReference === undefined
          ? {}
          : { inputReference: assessmentInputReference(body.inputReference) }),
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
