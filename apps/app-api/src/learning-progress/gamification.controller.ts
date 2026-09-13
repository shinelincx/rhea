import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import { FamilyAccessError, type FamilyAccess } from '@rhea/family-access';

import { FAMILY_ACCESS } from '../family-access/family-access.provider.js';
import { GAMIFICATION_SERVICE, type GamificationService } from './gamification.provider.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId/growth')
export class GamificationController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(GAMIFICATION_SERVICE) private readonly gamification: GamificationService,
  ) {}

  @Get()
  async getGrowth(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    await this.familyAccess.authorizeLearningProfile({
      accessToken: bearerToken(authorization),
      capability: 'learning.read',
      familySpaceId,
      learningProfileId,
    });
    return { data: await this.gamification.getGrowth({ familySpaceId, learningProfileId }) };
  }
}
