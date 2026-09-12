import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { ChallengeError, type ChallengeErrorCode } from '@rhea/challenge';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  send(body: unknown): void;
}

const CONFLICT = new Set<ChallengeErrorCode>([
  'CHALLENGE_NOT_ACTIVE',
  'INVITE_ALREADY_USED',
  'INVITE_EXPIRED',
  'ITEM_ALREADY_ANSWERED',
  'PARTNER_RELATION_INACTIVE',
  'WRITE_CONFLICT',
]);

@Catch(ChallengeError)
export class ChallengeExceptionFilter implements ExceptionFilter<ChallengeError> {
  catch(exception: ChallengeError, host: ArgumentsHost): void {
    const status =
      exception.code === 'ACCESS_DENIED'
        ? 403
        : exception.code.endsWith('_NOT_FOUND')
          ? 404
          : CONFLICT.has(exception.code)
            ? 409
            : 400;
    host
      .switchToHttp()
      .getResponse<ErrorResponse>()
      .status(status)
      .send({
        error: {
          code: exception.code,
          message: exception.message,
          recovery:
            exception.code === 'CHALLENGE_CONSENT_REQUIRED'
              ? 'ASK_GUARDIAN_TO_ENABLE_CHALLENGE'
              : exception.code === 'INVITE_EXPIRED' || exception.code === 'INVITE_ALREADY_USED'
                ? 'CREATE_NEW_INVITE'
                : exception.code === 'WRITE_CONFLICT'
                  ? 'REFRESH_AND_RETRY'
                  : 'CHECK_INPUT',
        },
      });
  }
}
