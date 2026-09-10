import { Body, Controller, Headers, Inject, Param, Post } from '@nestjs/common';

import { ASSESSMENT_SERVICE, type AssessmentService } from './assessment.provider.js';
import { assessmentCorrection, stringValue } from './assessment-request.js';
import {
  PROFESSIONAL_REVIEW_ACCESS,
  type ProfessionalReviewAccess,
} from './professional-review.provider.js';

@Controller(
  'v1/professional-reviews/family-spaces/:familySpaceId/learning-profiles/:learningProfileId',
)
export class ProfessionalReviewController {
  constructor(
    @Inject(PROFESSIONAL_REVIEW_ACCESS)
    private readonly access: ProfessionalReviewAccess,
    @Inject(ASSESSMENT_SERVICE) private readonly assessments: AssessmentService,
  ) {}

  @Post('objective-assessments/:assessmentId/disputes/:disputeId/resolution')
  async resolve(
    @Headers('authorization') authorization: string | undefined,
    @Param('familySpaceId') familySpaceId: string,
    @Param('learningProfileId') learningProfileId: string,
    @Param('assessmentId') assessmentId: string,
    @Param('disputeId') disputeId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const reviewer = await this.access.authorize({
      authorization,
      familySpaceId,
      learningProfileId,
    });
    return {
      data: await this.assessments.resolveProfessionalDispute({
        assessmentId,
        ...(body.correction === undefined
          ? {}
          : { correction: assessmentCorrection(body.correction) }),
        disputeId,
        learningProfileId,
        reason: stringValue(body.reason, '专业复核说明'),
        reviewCaseId: stringValue(body.reviewCaseId, '专业复核工单'),
        reviewer,
      }),
    };
  }
}
