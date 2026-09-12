import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { LearningProgressError, type LearningProgressErrorCode } from '@rhea/learning-progress';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<LearningProgressErrorCode, number> = {
  CAPABILITY_UNAVAILABLE: 503,
  CLASSIFICATION_INVALID: 400,
  CORRECTION_NOT_AVAILABLE: 409,
  CONSENT_REQUIRED: 403,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  INPUT_INVALID: 400,
  REASON_REVISION_INVALID: 400,
  REVIEW_CARD_NOT_FOUND: 404,
  REVIEW_CARD_NOT_READY: 409,
  REVIEW_SESSION_NOT_FOUND: 404,
  SOURCE_INELIGIBLE: 409,
  VERSION_CONFLICT: 409,
  WRONG_ITEM_NOT_FOUND: 404,
};

@Catch(LearningProgressError)
export class LearningProgressExceptionFilter implements ExceptionFilter<LearningProgressError> {
  catch(exception: LearningProgressError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(STATUS_BY_CODE[exception.code])
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery:
            exception.code === 'VERSION_CONFLICT' || exception.code === 'SOURCE_INELIGIBLE'
              ? 'REFRESH_WRONG_ITEM'
              : 'CHECK_INPUT',
        },
      });
  }
}
