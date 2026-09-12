import { Body, Controller, Delete, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import type { ChallengeActor, ChallengeSubject } from '@rhea/challenge';
import { FamilyAccessError } from '@rhea/family-access';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import { CHALLENGE_SERVICE, type ChallengeService } from './challenge.provider.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class ChallengeController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(CHALLENGE_SERVICE) private readonly challenge: ChallengeService,
  ) {}

  @Post('partner-invites')
  async createInvite(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return { data: await this.challenge.createPartnerInvite({ actor }) };
  }

  @Post('partner-invites/redeem')
  async redeemInvite(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: { code?: unknown },
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.challenge.redeemPartnerInvite({
        actor,
        code: typeof body.code === 'string' ? body.code : '',
      }),
    };
  }

  @Get('partner-relations')
  async listRelations(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return { data: await this.challenge.listPartnerRelations({ actor }) };
  }

  @Delete('partner-relations/:relationId')
  async dissolveRelation(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('relationId') relationId: string,
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return { data: await this.challenge.dissolvePartnerRelation({ actor, relationId }) };
  }

  @Post('challenges')
  async createChallenge(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: { relationId?: unknown; subject?: unknown; target?: unknown },
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.challenge.createChallenge({
        actor,
        relationId: typeof body.relationId === 'string' ? body.relationId : '',
        subject: (typeof body.subject === 'string' ? body.subject : '') as ChallengeSubject,
        target: typeof body.target === 'string' ? body.target : '',
      }),
    };
  }

  @Get('challenges')
  async listChallenges(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return { data: await this.challenge.listChallenges({ actor }) };
  }

  @Get('challenges/:challengeId')
  async getChallenge(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('challengeId') challengeId: string,
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return { data: await this.challenge.getChallenge({ actor, challengeId }) };
  }

  @Post('challenges/:challengeId/answers')
  async answer(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('challengeId') challengeId: string,
    @Body() body: { answer?: unknown; commandId?: unknown; itemId?: unknown },
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.challenge.submitAnswer({
        actor,
        answer: typeof body.answer === 'string' ? body.answer : '',
        challengeId,
        commandId: typeof body.commandId === 'string' ? body.commandId : '',
        itemId: typeof body.itemId === 'string' ? body.itemId : '',
      }),
    };
  }

  @Post('challenges/:challengeId/leave')
  async leave(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('challengeId') challengeId: string,
  ) {
    const actor = await this.actor(authorization, familySpaceId, learningProfileId);
    return { data: await this.challenge.leaveChallenge({ actor, challengeId }) };
  }

  private async actor(
    authorization: string | undefined,
    familySpaceId: string,
    learningProfileId: string,
  ): Promise<ChallengeActor> {
    const actor = await this.familyAccess.authorize({
      accessToken: bearerToken(authorization),
      capability: 'challenge.use',
    });
    if (
      actor.type !== 'learner' ||
      actor.familySpaceId !== familySpaceId ||
      actor.learningProfileId !== learningProfileId
    ) {
      throw new FamilyAccessError('CAPABILITY_DENIED', '只能使用当前学习档案参加挑战');
    }
    return { familySpaceId, learningProfileId };
  }
}
