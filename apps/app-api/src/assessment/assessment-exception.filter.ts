import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { AssessmentError, type AssessmentErrorCode } from '@rhea/assessment';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<AssessmentErrorCode, number> = {
  ASSESSMENT_NOT_FOUND: 404,
  BASIS_CHANGED: 409,
  DISPUTE_NOT_FOUND: 404,
  DISPUTE_RESOLUTION_REQUIRES_GUARDIAN: 403,
  DOWNSTREAM_INELIGIBLE: 409,
  INPUT_INVALID: 400,
  PROFESSIONAL_REVIEW_REQUIRED: 409,
  RULE_CONFIRMATION_REQUIRES_GUARDIAN: 403,
  TRUSTED_INPUT_NOT_FOUND: 422,
  VERSION_CONFLICT: 409,
};

@Catch(AssessmentError)
export class AssessmentExceptionFilter implements ExceptionFilter<AssessmentError> {
  catch(exception: AssessmentError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(STATUS_BY_CODE[exception.code])
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery:
            exception.code === 'VERSION_CONFLICT' || exception.code === 'BASIS_CHANGED'
              ? 'REFRESH_ASSESSMENT'
              : 'CHECK_INPUT',
        },
      });
  }
}
