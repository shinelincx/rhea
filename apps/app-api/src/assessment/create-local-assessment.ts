import {
  AssessmentService,
  deriveTrustedBuiltInRule,
  MemoryAssessmentStore,
  type ObjectiveAssessmentInputReader,
  type ObjectiveGradingRule,
} from '@rhea/assessment';
import type { LearningContentService } from '@rhea/learning-content';
import { SubmissionError, type SubmissionService } from '@rhea/submission';

export function createLocalAssessment(
  learningContent: LearningContentService,
  submissions: SubmissionService,
): AssessmentService {
  const confirmedRules = new Map<string, { id: string; rule: ObjectiveGradingRule }>();
  const ruleKey = (input: {
    basis: { selectionVersion: number; sourceVersionId: string; validityEpoch: number };
    materialId: string;
    reference: { confirmedContentVersionId: string; questionRegionId: string };
  }) =>
    [
      input.materialId,
      input.reference.confirmedContentVersionId,
      input.reference.questionRegionId,
      input.basis.sourceVersionId,
      input.basis.selectionVersion,
      input.basis.validityEpoch,
    ].join(':');
  const inputReader: ObjectiveAssessmentInputReader = {
    async confirmObjectiveRule(input) {
      if (!(await inputReader.resolveObjectiveInput(input))) return false;
      confirmedRules.set(ruleKey(input), {
        id: input.gradingRuleVersionId,
        rule: structuredClone(input.rule),
      });
      return true;
    },
    async resolveObjectiveInput(input) {
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
      const questionRegion = content.regions.find(
        ({ id, kind }) => id === input.reference.questionRegionId && kind === 'question',
      );
      const responseRegion = content.regions.find(
        ({ id, kind }) => id === input.reference.responseRegionId && kind === 'answer',
      );
      const subject = material.currentClassification.primarySubject;
      if (
        !questionRegion ||
        !responseRegion ||
        responseRegion.questionRegionId !== questionRegion.id ||
        !subject
      ) {
        return null;
      }
      const question = {
        subject,
        text: questionRegion.text,
        versionId: `${content.id}:${questionRegion.id}`,
      };
      const builtIn = deriveTrustedBuiltInRule(question);
      const confirmed = confirmedRules.get(ruleKey(input));
      return {
        gradingRuleVersionId: confirmed?.id ?? builtIn?.gradingRuleVersionId ?? null,
        question,
        requiresProfessionalReview: material.basis.hasConflict,
        response: {
          text: responseRegion.text,
          versionId: `${content.id}:${responseRegion.id}`,
        },
        rule: structuredClone(confirmed?.rule ?? builtIn?.rule ?? null),
      };
    },
  };
  return new AssessmentService({
    basisReader: learningContent,
    inputReader,
    store: new MemoryAssessmentStore(),
  });
}
