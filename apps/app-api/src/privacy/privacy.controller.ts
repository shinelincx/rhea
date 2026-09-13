import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { FamilyAccessError, type FamilyAccess } from '@rhea/family-access';

import { FAMILY_ACCESS } from '../family-access/family-access.provider.js';
import {
  PRIVACY_LIFECYCLE_SERVICE,
  PRIVACY_TASK_SCHEDULER,
  type PrivacyLifecycleService,
  type PrivacyTaskScheduler,
} from './privacy.provider.js';

function bearerToken(value: string | undefined) {
  if (!value?.startsWith('Bearer ') || value.length <= 7)
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  return value.slice(7);
}
function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

@Controller('v1/family-spaces/:familySpaceId')
export class PrivacyController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(PRIVACY_LIFECYCLE_SERVICE) private readonly privacy: PrivacyLifecycleService,
    @Inject(PRIVACY_TASK_SCHEDULER) private readonly scheduler: PrivacyTaskScheduler,
  ) {}

  @Get('learning-profiles/:learningProfileId/erasure-preview')
  async preview(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'data.erase',
      familySpaceId,
    });
    return { data: this.privacy.previewErasure({ familySpaceId, learningProfileId }) };
  }

  @Post('learning-profiles/:learningProfileId/exports')
  async exportProfile(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
  ) {
    const guardian = await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'data.export',
      familySpaceId,
    });
    const task = await this.privacy.requestExport({
      familySpaceId,
      learningProfileId,
      requestedByGuardianId: guardian.guardianId,
    });
    await this.scheduler.schedule(task.id);
    return { data: task };
  }

  @Get('learning-profiles/:learningProfileId/exports/:taskId/download')
  async downloadExport(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('taskId') taskId: string,
  ) {
    await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'data.export',
      familySpaceId,
    });
    return {
      data: await this.privacy.downloadExport({ familySpaceId, learningProfileId, taskId }),
    };
  }

  @Post('learning-profiles/:learningProfileId/erasure')
  async erase(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: { confirmationText?: unknown },
  ) {
    const guardian = await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'data.erase',
      familySpaceId,
    });
    const task = await this.privacy.requestErasure({
      confirmationText: text(body.confirmationText),
      familySpaceId,
      learningProfileId,
      requestedByGuardianId: guardian.guardianId,
    });
    await this.scheduler.schedule(task.id);
    return { data: task };
  }

  @Get('privacy-tasks/:taskId')
  async getTask(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('taskId') taskId: string,
  ) {
    await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'data.export',
      familySpaceId,
    });
    const task = await this.privacy.getTask(taskId, { familySpaceId });
    if (task.familySpaceId !== familySpaceId)
      throw new FamilyAccessError('CAPABILITY_DENIED', '不能访问其他家庭的隐私任务');
    return { data: task };
  }

  @Get('learning-profiles/:learningProfileId/privacy-tasks/:taskId/certificate')
  async getCertificate(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('taskId') taskId: string,
  ) {
    await this.familyAccess.authorizeSensitive({
      accessToken: bearerToken(authorization),
      capability: 'data.erase',
      familySpaceId,
    });
    return {
      data: await this.privacy.getErasureCertificate({
        familySpaceId,
        learningProfileId,
        taskId,
      }),
    };
  }
}
