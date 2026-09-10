import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { FamilyAccessError } from '@rhea/family-access';
import { GeneratedLearningError } from '@rhea/generated-learning';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import {
  LEARNING_CONTENT_SERVICE,
  type LearningContentService,
} from '../learning-content/learning-content.provider.js';
import { SUBMISSION_SERVICE, type SubmissionService } from '../submission/submission.provider.js';
import {
  GENERATED_LEARNING_SCHEDULER,
  GENERATED_LEARNING_SERVICE,
  type GeneratedLearningScheduler,
  type GeneratedLearningService,
} from './generated-learning.provider.js';
import { GeneratedLearningSourceResolver } from './generated-learning-source.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

function requiredHeader(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new FamilyAccessError('INPUT_INVALID', `${label}不能为空`);
  }
  return value;
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class GeneratedLearningController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(LEARNING_CONTENT_SERVICE) private readonly learningContent: LearningContentService,
    @Inject(SUBMISSION_SERVICE) private readonly submissions: SubmissionService,
    @Inject(GENERATED_LEARNING_SERVICE)
    private readonly generatedLearning: GeneratedLearningService,
    @Inject(GENERATED_LEARNING_SCHEDULER)
    private readonly scheduler: GeneratedLearningScheduler,
  ) {}

  @Post('learning-materials/:materialId/generated-learning-requests')
  @HttpCode(202)
  async request(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('materialId') materialId: string,
    @Body() body: { processingJobId?: unknown } | undefined,
  ) {
    const accessToken = bearerToken(authorization);
    const resolved = await new GeneratedLearningSourceResolver(
      this.familyAccess,
      this.learningContent,
      this.submissions,
    ).resolve({
      accessToken,
      familySpaceId,
      learningProfileId,
      materialId,
      processingJobId: typeof body?.processingJobId === 'string' ? body.processingJobId : '',
    });
    const request = await this.generatedLearning.requestContent({
      actor: resolved.actor,
      consentRevision: resolved.consentRevision,
      familySpaceId,
      idempotencyKey: requiredHeader(idempotencyKey, '幂等键'),
      learningProfileId,
      materialId,
      source: resolved.source,
    });
    if (request.status === 'queued') await this.scheduler.schedule(request);
    return { data: request };
  }

  @Get('generated-learning-requests/:requestId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('requestId') requestId: string,
  ) {
    await this.authorize(authorization, familySpaceId, learningProfileId, 'learning.read');
    return {
      data: await this.generatedLearning.getRequest({ learningProfileId, requestId }),
    };
  }

  @Post('generated-learning-requests/:requestId/reveal-next-hint')
  async reveal(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('requestId') requestId: string,
    @Body() body: { expectedLevel?: unknown } | undefined,
  ) {
    const actor = await this.authorize(
      authorization,
      familySpaceId,
      learningProfileId,
      'learning.submit',
    );
    if (
      typeof body?.expectedLevel !== 'number' ||
      !Number.isInteger(body.expectedLevel) ||
      body.expectedLevel < 0 ||
      body.expectedLevel > 3
    ) {
      throw new GeneratedLearningError('INPUT_INVALID', 'expectedLevel 必须是 0 到 3 的整数');
    }
    return {
      data: await this.generatedLearning.revealNextHint({
        actor:
          actor.type === 'guardian'
            ? { id: actor.guardianId, type: 'guardian' }
            : { id: actor.learningProfileId, type: 'learner' },
        expectedLevel: body.expectedLevel as 0 | 1 | 2 | 3,
        learningProfileId,
        requestId,
      }),
    };
  }

  @Post('generated-learning-requests/:requestId/cancel')
  async cancel(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('requestId') requestId: string,
  ) {
    await this.authorize(authorization, familySpaceId, learningProfileId, 'learning.submit');
    return {
      data: await this.generatedLearning.cancelRequest({ learningProfileId, requestId }),
    };
  }

  private authorize(
    authorization: string | undefined,
    familySpaceId: string,
    learningProfileId: string,
    capability: 'learning.read' | 'learning.submit',
  ) {
    return this.familyAccess.authorizeLearningProfile({
      accessToken: bearerToken(authorization),
      capability,
      familySpaceId,
      learningProfileId,
    });
  }
}
