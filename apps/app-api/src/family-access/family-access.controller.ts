import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CONSENT_CATALOG, FamilyAccessError, type ConsentKind } from '@rhea/family-access';

import { FAMILY_ACCESS, type FamilyAccess } from './family-access.provider.js';

function stringBody(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

function deviceToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Device ') || authorization.length <= 7) {
    throw new FamilyAccessError('DEVICE_INVALID', '设备入口无效，请由监护人重新设置');
  }
  return authorization.slice(7);
}

function consentKind(value: string): ConsentKind {
  const kind = CONSENT_CATALOG.find((statement) => statement.kind === value)?.kind;
  if (!kind) {
    throw new FamilyAccessError('INPUT_INVALID', '未知的分项授权类型');
  }
  return kind;
}

@Controller('v1')
export class FamilyAccessController {
  constructor(@Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess) {}

  @Post('guardian-sessions')
  async loginGuardian(@Body() body: { identityAssertion?: unknown }) {
    return {
      data: await this.familyAccess.loginGuardian({
        identityAssertion: stringBody(body.identityAssertion),
      }),
    };
  }

  @Post('guardian-reverification')
  async reverifyGuardian(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { identityAssertion?: unknown },
  ) {
    return {
      data: await this.familyAccess.reverifyGuardian({
        accessToken: bearerToken(authorization),
        identityAssertion: stringBody(body.identityAssertion),
      }),
    };
  }

  @Post('family-spaces')
  async createFamilySpace(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { name?: unknown },
  ) {
    return {
      data: await this.familyAccess.createFamilySpace({
        accessToken: bearerToken(authorization),
        name: stringBody(body.name),
      }),
    };
  }

  @Post('family-spaces/:familySpaceId/learning-profiles')
  async createLearningProfile(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Body() body: { displayName?: unknown; grade?: unknown; pin?: unknown },
  ) {
    return {
      data: await this.familyAccess.createLearningProfile({
        accessToken: bearerToken(authorization),
        displayName: stringBody(body.displayName),
        familySpaceId,
        grade: typeof body.grade === 'number' ? body.grade : null,
        pin: stringBody(body.pin),
      }),
    };
  }

  @Post('family-spaces/:familySpaceId/devices')
  async registerDevice(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Body() body: { label?: unknown },
  ) {
    return {
      data: await this.familyAccess.registerDevice({
        accessToken: bearerToken(authorization),
        familySpaceId,
        label: stringBody(body.label),
      }),
    };
  }

  @Get('family-spaces/:familySpaceId/consents')
  async listConsents(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
  ) {
    return {
      data: await this.familyAccess.listConsents({
        accessToken: bearerToken(authorization),
        familySpaceId,
      }),
    };
  }

  @Get('family-spaces/:familySpaceId/consents/:kind/history')
  async listConsentHistory(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('kind') kind: string,
  ) {
    return {
      data: await this.familyAccess.listConsentHistory({
        accessToken: bearerToken(authorization),
        familySpaceId,
        kind: consentKind(kind),
      }),
    };
  }

  @Put('family-spaces/:familySpaceId/consents/:kind')
  async changeConsent(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('kind') kind: string,
    @Body() body: { granted?: unknown },
  ) {
    if (typeof body.granted !== 'boolean') {
      throw new FamilyAccessError('INPUT_INVALID', '授权决定必须是同意或拒绝');
    }
    return {
      data: await this.familyAccess.changeConsent({
        accessToken: bearerToken(authorization),
        familySpaceId,
        granted: body.granted,
        kind: consentKind(kind),
      }),
    };
  }

  @Get('device-learning-profiles')
  async listDeviceProfiles(@Headers('authorization') authorization: string | undefined) {
    return {
      data: await this.familyAccess.listDeviceProfiles({
        deviceAccessToken: deviceToken(authorization),
      }),
    };
  }

  @Post('learner-sessions')
  async issueLearnerSession(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { learningProfileId?: unknown; pin?: unknown },
  ) {
    return {
      data: await this.familyAccess.issueLearnerSession({
        deviceAccessToken: deviceToken(authorization),
        learningProfileId: stringBody(body.learningProfileId),
        pin: stringBody(body.pin),
      }),
    };
  }

  @Get('session')
  async getSession(@Headers('authorization') authorization: string | undefined) {
    return {
      data: await this.familyAccess.getSession({
        accessToken: bearerToken(authorization),
      }),
    };
  }

  @Delete('session')
  @HttpCode(204)
  async logout(@Headers('authorization') authorization: string | undefined): Promise<void> {
    await this.familyAccess.logout({ accessToken: bearerToken(authorization) });
  }
}
