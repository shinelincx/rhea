import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { ReportingError, type ReportingErrorCode } from '@rhea/reporting';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<ReportingErrorCode, number> = {
  ACCESS_DENIED: 403,
  GUARDIAN_REQUIRED: 403,
  INPUT_INVALID: 400,
};

@Catch(ReportingError)
export class ReportingExceptionFilter implements ExceptionFilter<ReportingError> {
  catch(exception: ReportingError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(STATUS_BY_CODE[exception.code])
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery: exception.code === 'GUARDIAN_REQUIRED' ? 'ENTER_GUARDIAN_MODE' : 'CHECK_INPUT',
        },
      });
  }
}
