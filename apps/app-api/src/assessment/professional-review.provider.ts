import { AssessmentError, type ProfessionalReviewerReference } from '@rhea/assessment';

export const PROFESSIONAL_REVIEW_ACCESS = Symbol('PROFESSIONAL_REVIEW_ACCESS');

export interface ProfessionalReviewAccess {
  authorize(input: {
    authorization: string | undefined;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<ProfessionalReviewerReference>;
}

export const unavailableProfessionalReviewAccess: ProfessionalReviewAccess = {
  async authorize() {
    throw new AssessmentError(
      'PROFESSIONAL_REVIEW_UNAVAILABLE',
      '当前没有已接入的合格专业复核能力，结果将继续保持待复核',
    );
  },
};
