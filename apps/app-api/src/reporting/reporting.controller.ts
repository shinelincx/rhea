import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import { FamilyAccessError, type Actor } from '@rhea/family-access';
import type { ReportingActor } from '@rhea/reporting';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import { REPORTING_SERVICE, type ReportingService } from './reporting.provider.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

function reportingActor(actor: Actor): ReportingActor {
  return actor.type === 'guardian'
    ? { id: actor.guardianId, type: 'guardian' }
    : { id: actor.learningProfileId, type: 'learner' };
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class ReportingController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(REPORTING_SERVICE) private readonly reporting: ReportingService,
  ) {}

  @Get('today-route')
  async getTodayRoute(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.reporting.getTodayRoute({
        actor: reportingActor(actor),
        familySpaceId,
        learningProfileId,
      }),
    };
  }

  @Get('guardian-report')
  async getGuardianReport(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const actor = await this.authorize(authorization, familySpaceId, learningProfileId);
    return {
      data: await this.reporting.getGuardianReport({
        actor: reportingActor(actor),
        familySpaceId,
        learningProfileId,
      }),
    };
  }

  private async authorize(
    authorization: string | undefined,
    familySpaceId: string,
    learningProfileId: string,
  ): Promise<Actor> {
    return this.familyAccess.authorizeLearningProfile({
      accessToken: bearerToken(authorization),
      capability: 'learning.read',
      familySpaceId,
      learningProfileId,
    });
  }
}
