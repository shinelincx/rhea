import {
  deriveProfessionallyReviewedOpenRubric,
  MemorySuggestedAssessmentStore,
  openAssessmentAgeBandForGrade,
  SuggestedAssessmentService,
  type OpenAssessmentInputReader,
} from '@rhea/assessment';
import type { AiProcessingConsentPublicationReader } from '@rhea/family-access';
import type { LearningContentService } from '@rhea/learning-content';
import { SubmissionError, type SubmissionService } from '@rhea/submission';

import { createLocalCapabilityAuthorization } from '../quality-control/local-capability-authorization.js';

export function createLocalSuggestedAssessment(
  learningContent: LearningContentService,
  submissions: SubmissionService,
  consentReader: AiProcessingConsentPublicationReader,
): SuggestedAssessmentService {
  const inputReader: OpenAssessmentInputReader = {
    async resolveOpenAssessmentInput(input) {
      let job;
      try {
        job = await submissions.getJob({
          id: input.reference.processingJobId,
          learningProfileId: input.learningProfileId,
        });
      } catch (error) {
        if (error instanceof SubmissionError && error.code === 'JOB_NOT_FOUND') return null;
        throw error;
      }
      const material = await learningContent.getMaterial({
        actor: input.actor,
        learningProfileId: input.learningProfileId,
        materialId: input.materialId,
      });
      const content = job.completedContent;
      if (
        !content ||
        material.confirmedContentVersionId !== input.reference.confirmedContentVersionId ||
        content.id !== input.reference.confirmedContentVersionId ||
        material.basis.currentSourceVersionId !== input.basis.sourceVersionId ||
        material.basis.selectionRevision !== input.basis.selectionVersion ||
        material.validityEpoch !== input.basis.validityEpoch
      ) {
        return null;
      }
      const question = content.regions.find(
        ({ id, kind }) => id === input.reference.questionRegionId && kind === 'question',
      );
      const response = content.regions.find(
        ({ id, kind }) => id === input.reference.responseRegionId && kind === 'answer',
      );
      const subject = material.currentClassification.primarySubject;
      if (!question || !response || response.questionRegionId !== question.id || !subject) {
        return null;
      }
      return {
        question: {
          subject,
          text: question.text,
          versionId: `${content.id}:${question.id}`,
        },
        requiresProfessionalReview: material.basis.hasConflict,
        response: {
          text: response.text,
          versionId: `${content.id}:${response.id}`,
        },
        rubric: deriveProfessionallyReviewedOpenRubric({
          ageBand: input.ageBand,
          subject,
          taskType: input.taskType,
        }),
      };
    },
  };
  return new SuggestedAssessmentService({
    basisReader: learningContent,
    inputReader,
    modelGateway: {
      async runStructured() {
        throw new Error('MODEL_CAPABILITY_UNAVAILABLE');
      },
    },
    publicationGate: {
      async authorize(input) {
        const consent = await consentReader.getAiProcessingConsentSnapshotForPublication({
          familySpaceId: input.familySpaceId,
          learningProfileId: input.learningProfileId,
        });
        const expectedAgeBand = openAssessmentAgeBandForGrade(consent?.grade ?? null);
        return (
          consent?.status === 'granted' &&
          consent.revision === input.consentRevision &&
          expectedAgeBand === input.ageBand
        );
      },
    },
    qualityControl: createLocalCapabilityAuthorization(null),
    store: new MemorySuggestedAssessmentStore(),
  });
}
