import { Body, Controller, Get, Headers, Inject, Param, Post, Put } from '@nestjs/common';
import { FamilyAccessError, type Actor } from '@rhea/family-access';
import {
  LearningContentError,
  type ClassificationDraft,
  type LearningActorReference,
  type LearningSourceKind,
  type Subject,
} from '@rhea/learning-content';

import { FAMILY_ACCESS, type FamilyAccess } from '../family-access/family-access.provider.js';
import { SUBMISSION_SERVICE, type SubmissionService } from '../submission/submission.provider.js';
import {
  LEARNING_CONTENT_SERVICE,
  type LearningContentService,
} from './learning-content.provider.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
  }
  return authorization.slice(7);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new LearningContentError('CLASSIFICATION_INVALID', `${label}必须是文本`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new LearningContentError('CLASSIFICATION_INVALID', `${label}必须是文本列表`);
  }
  return value;
}

function classification(body: Record<string, unknown>): ClassificationDraft {
  return {
    coursePathName: nullableString(body.coursePathName, '课程路径'),
    knowledgePointNames: stringArray(body.knowledgePointNames ?? [], '知识点'),
    primaryKnowledgePointName: nullableString(body.primaryKnowledgePointName, '主要知识点'),
    primarySubject: nullableString(body.primarySubject, '主学科') as Subject | null,
    relatedSubjects: stringArray(body.relatedSubjects ?? [], '关联学科') as Subject[],
    unitName: nullableString(body.unitName, '学习单元'),
  };
}

function actorReference(actor: Actor): LearningActorReference {
  return actor.type === 'guardian'
    ? { id: actor.guardianId, type: 'guardian' }
    : { id: actor.learningProfileId, type: 'learner' };
}

@Controller('v1/family-spaces/:familySpaceId/learning-profiles/:learningProfileId')
export class LearningContentController {
  constructor(
    @Inject(FAMILY_ACCESS) private readonly familyAccess: FamilyAccess,
    @Inject(LEARNING_CONTENT_SERVICE) private readonly learningContent: LearningContentService,
    @Inject(SUBMISSION_SERVICE) private readonly submissions: SubmissionService,
  ) {}

  @Post('learning-materials')
  async organize(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Body() body: { classification?: Record<string, unknown>; processingJobId?: unknown },
  ) {
    const actor = await this.authorize(
      authorization,
      familySpaceId,
      learningProfileId,
      'learning.submit',
    );
    const job = await this.submissions.getJob({
      id: stringValue(body.processingJobId, '识别任务'),
      learningProfileId,
    });
    if (job.status !== 'completed' || !job.completedContent) {
      throw new LearningContentError(
        'CONFIRMED_CONTENT_UNAVAILABLE',
        '只有已经确认的内容才能整理为学习资料',
      );
    }
    return {
      data: await this.learningContent.organizeConfirmedContent({
        actor: actorReference(actor),
        classification: classification(body.classification ?? {}),
        confirmedContentVersion: job.completedContent.version,
        confirmedContentVersionId: job.completedContent.id,
        familySpaceId,
        learningProfileId,
        sourceHash: job.completedContent.sourceHash,
      }),
    };
  }

  @Get('learning-materials/:materialId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('materialId') materialId: string,
  ) {
    await this.authorize(authorization, familySpaceId, learningProfileId, 'learning.read');
    return {
      data: await this.learningContent.getMaterial({ learningProfileId, materialId }),
    };
  }

  @Get('learning-materials/:materialId/current-basis-reference')
  async getCurrentBasisReference(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('materialId') materialId: string,
  ) {
    await this.authorize(authorization, familySpaceId, learningProfileId, 'learning.read');
    return {
      data: await this.learningContent.getCurrentBasisReference({
        learningProfileId,
        materialId,
      }),
    };
  }

  @Put('learning-materials/:materialId/classification')
  async correctClassification(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('materialId') materialId: string,
    @Body() body: { classification?: Record<string, unknown>; reason?: unknown },
  ) {
    const actor = await this.authorize(
      authorization,
      familySpaceId,
      learningProfileId,
      'learning.submit',
    );
    return {
      data: await this.learningContent.correctClassification({
        actor: actorReference(actor),
        classification: classification(body.classification ?? {}),
        learningProfileId,
        materialId,
        reason: stringValue(body.reason, '修正原因'),
      }),
    };
  }

  @Post('learning-materials/:materialId/source-versions')
  async addSource(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('materialId') materialId: string,
    @Body()
    body: {
      conflictsWithSourceVersionIds?: unknown;
      contentHash?: unknown;
      kind?: unknown;
      label?: unknown;
      versionLabel?: unknown;
    },
  ) {
    const actor = await this.authorize(
      authorization,
      familySpaceId,
      learningProfileId,
      'learning.submit',
    );
    return {
      data: await this.learningContent.addSourceVersion({
        actor: actorReference(actor),
        conflictsWithSourceVersionIds: stringArray(
          body.conflictsWithSourceVersionIds ?? [],
          '冲突来源',
        ),
        contentHash: stringValue(body.contentHash, '来源摘要'),
        kind: stringValue(body.kind, '来源类型') as LearningSourceKind,
        label: stringValue(body.label, '来源名称'),
        learningProfileId,
        materialId,
        versionLabel: stringValue(body.versionLabel, '来源版本'),
      }),
    };
  }

  @Put('learning-materials/:materialId/current-basis')
  async selectBasis(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('materialId') materialId: string,
    @Body() body: { reason?: unknown; sourceVersionId?: unknown },
  ) {
    const actor = await this.authorize(
      authorization,
      familySpaceId,
      learningProfileId,
      'learning.submit',
    );
    return {
      data: await this.learningContent.selectCurrentBasis({
        actor: actorReference(actor),
        learningProfileId,
        materialId,
        reason: stringValue(body.reason, '选择原因'),
        sourceVersionId: stringValue(body.sourceVersionId, '学习依据版本'),
      }),
    };
  }

  private async authorize(
    authorization: string | undefined,
    familySpaceId: string,
    learningProfileId: string,
    capability: 'learning.read' | 'learning.submit',
  ): Promise<Actor> {
    return this.familyAccess.authorizeLearningProfile({
      accessToken: bearerToken(authorization),
      capability,
      familySpaceId,
      learningProfileId,
    });
  }
}
