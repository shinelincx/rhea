import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { PrivacyLifecycleError } from '@rhea/privacy-lifecycle';

interface ErrorResponse {
  send(body: unknown): void;
  status(code: number): ErrorResponse;
}

@Catch(PrivacyLifecycleError)
export class PrivacyLifecycleExceptionFilter implements ExceptionFilter<PrivacyLifecycleError> {
  catch(exception: PrivacyLifecycleError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(
        exception.code === 'PRIVACY_INPUT_INVALID'
          ? 400
          : exception.code === 'PRIVACY_TASK_NOT_READY'
            ? 409
            : 404,
      )
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery:
            exception.code === 'PRIVACY_INPUT_INVALID'
              ? 'CHECK_INPUT'
              : exception.code === 'PRIVACY_TASK_NOT_READY'
                ? 'RETRY_LATER'
                : 'REFRESH',
        },
      });
  }
}
