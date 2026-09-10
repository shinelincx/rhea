import type { Actor, FamilyAccess, Grade } from '@rhea/family-access';
import {
  GeneratedLearningError,
  type AgeBand,
  type GeneratedLearningActorReference,
  type GenerationSourceSnapshot,
} from '@rhea/generated-learning';
import type { LearningContentService } from '@rhea/learning-content';
import { SubmissionError, type SubmissionService } from '@rhea/submission';

function actorReference(actor: Actor): GeneratedLearningActorReference {
  return actor.type === 'guardian'
    ? { id: actor.guardianId, type: 'guardian' }
    : { id: actor.learningProfileId, type: 'learner' };
}

function ageBand(grade: Grade | null): AgeBand {
  if (grade === null || grade <= 2) return 'lower_primary';
  return grade <= 4 ? 'middle_primary' : 'upper_primary';
}

export class GeneratedLearningSourceResolver {
  constructor(
    private readonly familyAccess: FamilyAccess,
    private readonly learningContent: LearningContentService,
    private readonly submissions: SubmissionService,
  ) {}

  async resolve(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
    materialId: string;
    processingJobId: string;
  }): Promise<{
    actor: GeneratedLearningActorReference;
    consentRevision: number;
    source: GenerationSourceSnapshot;
  }> {
    const actor = await this.familyAccess.authorizeLearningProfile({
      accessToken: input.accessToken,
      capability: 'learning.submit',
      familySpaceId: input.familySpaceId,
      learningProfileId: input.learningProfileId,
    });
    const [profile, consent] = await Promise.all([
      this.familyAccess.getLearningProfile({
        accessToken: input.accessToken,
        familySpaceId: input.familySpaceId,
        learningProfileId: input.learningProfileId,
      }),
      this.familyAccess.requireConsent({
        accessToken: input.accessToken,
        familySpaceId: input.familySpaceId,
        kind: 'ai_processing',
      }),
    ]);
    const reference = actorReference(actor);
    const material = await this.learningContent.getMaterial({
      actor: reference,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    let job;
    try {
      job = await this.submissions.getJob({
        id: input.processingJobId,
        learningProfileId: input.learningProfileId,
      });
    } catch (error) {
      if (error instanceof SubmissionError && error.code === 'JOB_NOT_FOUND') {
        throw new GeneratedLearningError('SOURCE_UNAVAILABLE', '没有找到可用于生成的已确认内容');
      }
      throw error;
    }
    const content = job.completedContent;
    const classification = material.currentClassification;
    if (
      job.status !== 'completed' ||
      !content ||
      material.familySpaceId !== input.familySpaceId ||
      material.confirmedContentVersionId !== content.id ||
      classification.status !== 'classified' ||
      !classification.primarySubject
    ) {
      throw new GeneratedLearningError(
        'SOURCE_UNAVAILABLE',
        '请先确认识别内容并完成学科归类，再生成学习内容',
      );
    }
    const basis = await this.learningContent.getCurrentBasisReference({
      actor: reference,
      learningProfileId: input.learningProfileId,
      materialId: input.materialId,
    });
    const basisSource = material.sourceVersions.find(({ id }) => id === basis.sourceVersionId);
    return {
      actor: reference,
      consentRevision: consent.revision,
      source: {
        ageBand: ageBand(profile.grade),
        basis,
        basisHasConflict:
          material.basis.hasConflict ||
          !basisSource ||
          basisSource.sourceConfirmedContentVersionId !== content.id,
        classificationRevision: classification.revision,
        confirmedContentVersionId: content.id,
        coursePathName: classification.coursePath?.name ?? null,
        excerpts: content.regions.map(({ id, kind, text }) => ({ kind, regionId: id, text })),
        knowledgePointNames: classification.knowledgePoints.map(({ name }) => name),
        processingJobId: job.id,
        subject: classification.primarySubject,
        unitName: classification.unit?.name ?? null,
      },
    };
  }
}
