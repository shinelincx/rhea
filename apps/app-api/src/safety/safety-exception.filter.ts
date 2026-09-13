import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { SafetyEscalationError } from '@rhea/safety-escalation';

interface ErrorResponse {
  send(body: unknown): void;
  status(code: number): ErrorResponse;
}

@Catch(SafetyEscalationError)
export class SafetyEscalationExceptionFilter implements ExceptionFilter<SafetyEscalationError> {
  catch(exception: SafetyEscalationError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(
        exception.code === 'SAFETY_INPUT_INVALID'
          ? 400
          : exception.code === 'SUPPORT_ACCESS_DENIED'
            ? 403
            : 404,
      )
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery: exception.code === 'SAFETY_INPUT_INVALID' ? 'CHECK_INPUT' : 'REFRESH',
        },
      });
  }
}
