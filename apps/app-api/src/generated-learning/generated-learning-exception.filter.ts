import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { GeneratedLearningError, type GeneratedLearningErrorCode } from '@rhea/generated-learning';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<GeneratedLearningErrorCode, number> = {
  GENERATION_NOT_READY: 409,
  GENERATION_REQUEST_NOT_FOUND: 404,
  INPUT_INVALID: 400,
  SOURCE_UNAVAILABLE: 422,
  VERSION_CONFLICT: 409,
};

@Catch(GeneratedLearningError)
export class GeneratedLearningExceptionFilter implements ExceptionFilter<GeneratedLearningError> {
  catch(exception: GeneratedLearningError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(STATUS_BY_CODE[exception.code])
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery:
            exception.code === 'VERSION_CONFLICT'
              ? 'REFRESH_GENERATION'
              : exception.code === 'SOURCE_UNAVAILABLE'
                ? 'CONFIRM_OR_CLASSIFY_SOURCE'
                : 'CHECK_INPUT',
        },
      });
  }
}
