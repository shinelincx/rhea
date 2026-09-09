import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { FamilyAccessError, type FamilyAccessErrorCode } from '@rhea/family-access';

interface ErrorResponse {
  header(name: string, value: string): ErrorResponse;
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const STATUS_BY_CODE: Record<FamilyAccessErrorCode, number> = {
  CAPABILITY_DENIED: 403,
  DEVICE_INVALID: 401,
  DEVICE_PROFILE_NOT_FOUND: 404,
  FAMILY_ACCESS_DENIED: 403,
  IDENTITY_INVALID: 401,
  INPUT_INVALID: 400,
  PIN_INVALID: 401,
  PIN_LOCKED: 429,
  SESSION_EXPIRED: 401,
  SESSION_INVALID: 401,
};

function recoveryFor(code: FamilyAccessErrorCode): string {
  if (code === 'PIN_LOCKED') {
    return 'WAIT_AND_RETRY';
  }
  if (code === 'CAPABILITY_DENIED' || code === 'FAMILY_ACCESS_DENIED') {
    return 'ENTER_GUARDIAN_MODE';
  }
  if (code === 'SESSION_EXPIRED' || code === 'SESSION_INVALID') {
    return 'REENTER_SESSION';
  }
  if (code === 'DEVICE_INVALID' || code === 'DEVICE_PROFILE_NOT_FOUND') {
    return 'ASK_GUARDIAN_TO_CHECK_DEVICE';
  }
  if (code === 'IDENTITY_INVALID') {
    return 'LOGIN_AGAIN';
  }
  return 'CHECK_INPUT_AND_RETRY';
}

@Catch(FamilyAccessError)
export class FamilyAccessExceptionFilter implements ExceptionFilter<FamilyAccessError> {
  catch(exception: FamilyAccessError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ErrorResponse>();
    if (exception.retryAfterSeconds !== undefined) {
      response.header('Retry-After', String(exception.retryAfterSeconds));
    }
    response.status(STATUS_BY_CODE[exception.code]).send({
      error: {
        code: exception.code,
        message: exception.message,
        recovery: recoveryFor(exception.code),
        ...(exception.remainingAttempts === undefined
          ? {}
          : { remainingAttempts: exception.remainingAttempts }),
        ...(exception.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: exception.retryAfterSeconds }),
      },
    });
  }
}
