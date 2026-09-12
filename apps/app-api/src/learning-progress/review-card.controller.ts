import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { AssessmentActorReference } from '@rhea/assessment';
import { FamilyAccessError, type Actor } from '@rhea/family-access';
import { LearningProgressError } from '@rhea/learning-progress';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import {
  REVIEW_CARD_CONSENT_READER,
  REVIEW_CARD_SCHEDULER,
  REVIEW_CARD_SERVICE,
  type AiProcessingConsentPublicationReader,
  type ReviewCardScheduler,
  type ReviewCardService,
} from './learning-progress.provider.js';

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

function ageBand(grade: number | null) {
  if (grade === null) throw new LearningProgressError('CONSENT_REQUIRED', '请先设置学习者年级');
  return grade <= 2
    ? ('lower_primary' as const)
    : grade <= 4
      ? ('middle_primary' as const)
      : ('upper_primary' as const);
}

function requiredIdempotencyKey(value: string | undefined): string {
  if (!value?.trim())
    throw new LearningProgressError('IDEMPOTENCY_KEY_REQUIRED', '请求必须提供 Idempotency-Key');
  return value;
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class ReviewCardController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(REVIEW_CARD_CONSENT_READER)
    private readonly consentReader: AiProcessingConsentPublicationReader,
    @Inject(REVIEW_CARD_SERVICE) private readonly reviewCards: ReviewCardService,
    @Inject(REVIEW_CARD_SCHEDULER) private readonly scheduler: ReviewCardScheduler,
  ) {}

  @Post('wrong-items/:wrongItemId/review-card-requests')
  @HttpCode(202)
  async request(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('wrongItemId') wrongItemId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'submit');
    const consent = await this.consentReader.getAiProcessingConsentSnapshotForPublication({
      familySpaceId,
      learningProfileId,
    });
    if (!consent || consent.status !== 'granted') {
      throw new LearningProgressError('CONSENT_REQUIRED', '需要监护人有效的 AI 处理同意');
    }
    const request = await this.reviewCards.requestReviewCard({
      actor: actorReference(actor),
      ageBand: ageBand(consent.grade),
      consentRevision: consent.revision,
      familySpaceId,
      idempotencyKey: requiredIdempotencyKey(idempotencyKey),
      learningProfileId,
      wrongItemId,
    });
    if (request.status === 'queued') await this.scheduler.schedule(request);
    return { data: request };
  }

  @Get('review-card-requests/:requestId')
  async getRequest(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('requestId') requestId: string,
  ) {
    await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return { data: await this.reviewCards.getRequest({ learningProfileId, requestId }) };
  }

  @Post('short-review-sessions')
  async createSession(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'submit');
    return {
      data: await this.reviewCards.createShortReviewSession({
        actor: actorReference(actor),
        learningProfileId,
      }),
    };
  }

  @Get('short-review-sessions/:sessionId')
  async getSession(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.authorize(authorization, familySpaceId, learningProfileId, 'read');
    return { data: await this.reviewCards.getShortReviewSession({ learningProfileId, sessionId }) };
  }

  @Post('short-review-sessions/:sessionId/cards/:cardId/attempts')
  async submitAttempt(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('sessionId') sessionId: string,
    @Param('cardId') cardId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId, 'submit');
    if (
      typeof body.hintLevel !== 'number' ||
      !Number.isInteger(body.hintLevel) ||
      body.hintLevel < 0 ||
      body.hintLevel > 2
    ) {
      throw new LearningProgressError('INPUT_INVALID', 'hintLevel 必须是 0 到 2 的整数');
    }
    if (typeof body.responseText !== 'string')
      throw new LearningProgressError('INPUT_INVALID', '复习作答必须是文本');
    if (
      body.perceivedDifficulty !== undefined &&
      body.perceivedDifficulty !== null &&
      !['easy', 'okay', 'hard'].includes(String(body.perceivedDifficulty))
    ) {
      throw new LearningProgressError('INPUT_INVALID', '主观难度无效');
    }
    return {
      data: await this.reviewCards.submitAttempt({
        actor: actorReference(actor),
        cardId,
        hintLevel: body.hintLevel as 0 | 1 | 2,
        idempotencyKey: requiredIdempotencyKey(idempotencyKey),
        learningProfileId,
        perceivedDifficulty: (body.perceivedDifficulty ?? null) as 'easy' | 'hard' | 'okay' | null,
        responseText: body.responseText,
        sessionId,
      }),
    };
  }

  private authorize(
    authorization: string | undefined,
    familySpaceId: string,
    learningProfileId: string,
    mode: 'read' | 'submit',
  ) {
    return this.familyAccess.authorizeLearningProfile({
      accessToken: bearerToken(authorization),
      capability: mode === 'read' ? 'learning.read' : 'learning.submit',
      familySpaceId,
      learningProfileId,
    });
  }
}
