import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { SubmissionError, type SubmissionErrorCode } from '@rhea/submission';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<SubmissionErrorCode, number> = {
  INPUT_INVALID: 400,
  JOB_NOT_FOUND: 404,
  JOB_STATE_CONFLICT: 409,
  UPLOAD_EXPIRED: 410,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_NOT_FOUND: 404,
  UPLOAD_TOKEN_INVALID: 401,
};

@Catch(SubmissionError)
export class SubmissionExceptionFilter implements ExceptionFilter<SubmissionError> {
  catch(exception: SubmissionError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(STATUS_BY_CODE[exception.code])
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery:
            exception.code === 'UPLOAD_EXPIRED'
              ? 'CREATE_NEW_UPLOAD'
              : exception.code === 'JOB_STATE_CONFLICT'
                ? 'REFRESH_JOB'
                : 'CHECK_INPUT_AND_RETRY',
        },
      });
  }
}
