import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { LearningContentError, type LearningContentErrorCode } from '@rhea/learning-content';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<LearningContentErrorCode, number> = {
  CLASSIFICATION_INVALID: 400,
  CONFIRMED_CONTENT_ALREADY_ORGANIZED: 409,
  CONFIRMED_CONTENT_UNAVAILABLE: 409,
  MATERIAL_NOT_FOUND: 404,
  SOURCE_INVALID: 400,
  UPSTREAM_INVALIDATED: 409,
  VERSION_CONFLICT: 409,
};

@Catch(LearningContentError)
export class LearningContentExceptionFilter implements ExceptionFilter<LearningContentError> {
  catch(exception: LearningContentError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(STATUS_BY_CODE[exception.code])
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery: exception.code === 'VERSION_CONFLICT' ? 'REFRESH_MATERIAL' : 'CHECK_INPUT',
        },
      });
  }
}
