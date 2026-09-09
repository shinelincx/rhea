import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { FamilyAccessError, type LearnerActor } from '@rhea/family-access';
import type { UploadPageInput } from '@rhea/submission';
import { distinctUntilChanged, from, interval, map, startWith, switchMap } from 'rxjs';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import {
  SUBMISSION_SCHEDULER,
  SUBMISSION_SERVICE,
  type SubmissionScheduler,
  type SubmissionService,
} from './submission.provider.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

async function learnerActor(
  familyAccess: FamilyAccess,
  authorization: string | undefined,
): Promise<{ actor: LearnerActor; token: string }> {
  const token = bearerToken(authorization);
  const actor = await familyAccess.authorize({ accessToken: token, capability: 'learning.submit' });
  if (actor.type !== 'learner') {
    throw new FamilyAccessError('CAPABILITY_DENIED', '请进入学习档案后再提交作业');
  }
  return { actor, token };
}

@Controller('v1')
export class SubmissionController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(SUBMISSION_SERVICE) private readonly submissions: SubmissionService,
    @Inject(SUBMISSION_SCHEDULER) private readonly scheduler: SubmissionScheduler,
  ) {}

  @Post('upload-sessions')
  async createUpload(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { pages?: UploadPageInput[] },
  ) {
    const { actor, token } = await learnerActor(this.familyAccess, authorization);
    await this.familyAccess.requireConsent({
      accessToken: token,
      familySpaceId: actor.familySpaceId,
      kind: 'photo_processing',
    });
    const upload = await this.submissions.createUploadSession({
      familySpaceId: actor.familySpaceId,
      learningProfileId: actor.learningProfileId,
      pages: Array.isArray(body.pages) ? body.pages : [],
    });
    return {
      data: {
        ...upload,
        pages: upload.pages.map((page) => ({
          id: page.id,
          method: page.method,
          url: `/v1/upload-sessions/${upload.id}/pages/${page.id}?profile=${encodeURIComponent(actor.learningProfileId)}&token=${encodeURIComponent(page.uploadToken)}`,
        })),
      },
    };
  }

  @Put('upload-sessions/:uploadSessionId/pages/:pageId')
  @HttpCode(204)
  async uploadPage(
    @Param('uploadSessionId') uploadSessionId: string,
    @Param('pageId') pageId: string,
    @Query('profile') learningProfileId: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: Buffer,
  ): Promise<void> {
    await this.submissions.uploadPage({
      bytes: new Uint8Array(body),
      learningProfileId: learningProfileId ?? '',
      pageId,
      token: token ?? '',
      uploadSessionId,
    });
  }

  @Post('submissions')
  @HttpCode(202)
  async submit(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { uploadSessionId?: unknown },
  ) {
    const { actor, token } = await learnerActor(this.familyAccess, authorization);
    await this.familyAccess.requireConsent({
      accessToken: token,
      familySpaceId: actor.familySpaceId,
      kind: 'photo_processing',
    });
    const job = await this.submissions.submit({
      learningProfileId: actor.learningProfileId,
      uploadSessionId: typeof body.uploadSessionId === 'string' ? body.uploadSessionId : '',
    });
    this.scheduler.schedule(job, actor.learningProfileId);
    return { data: job };
  }

  @Get('processing-jobs/:id')
  async getJob(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const { actor } = await learnerActor(this.familyAccess, authorization);
    return {
      data: await this.submissions.getJob({ id, learningProfileId: actor.learningProfileId }),
    };
  }

  @Sse('processing-jobs/:id/events')
  async events(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const { actor } = await learnerActor(this.familyAccess, authorization);
    return interval(500).pipe(
      startWith(0),
      switchMap(() =>
        from(this.submissions.getJob({ id, learningProfileId: actor.learningProfileId })),
      ),
      distinctUntilChanged((left, right) => left.updatedAt === right.updatedAt),
      map((job): MessageEvent => ({ data: job, id: `${job.id}:${job.updatedAt}`, type: 'job' })),
    );
  }

  @Post('processing-jobs/:id/cancel')
  async cancel(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const { actor } = await learnerActor(this.familyAccess, authorization);
    return {
      data: await this.submissions.cancel({ id, learningProfileId: actor.learningProfileId }),
    };
  }

  @Put('content-confirmations/:id')
  async confirm(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { edits?: Record<string, unknown> },
  ) {
    const { actor } = await learnerActor(this.familyAccess, authorization);
    const edits = Object.fromEntries(
      Object.entries(body.edits ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    return {
      data: await this.submissions.confirm({
        edits,
        id,
        learningProfileId: actor.learningProfileId,
      }),
    };
  }
}
