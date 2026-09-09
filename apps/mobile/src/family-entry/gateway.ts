export interface MobileLearningProfile {
  displayName: string;
  familySpaceId: string;
  grade: number | null;
  id: string;
}

export type FamilyEntryErrorCode =
  | 'DEVICE_INVALID'
  | 'IDENTITY_INVALID'
  | 'PIN_INVALID'
  | 'PIN_LOCKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID'
  | 'UNKNOWN';

export class FamilyEntryGatewayError extends Error {
  readonly code: FamilyEntryErrorCode;
  readonly remainingAttempts: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: FamilyEntryErrorCode,
    message: string,
    details: { remainingAttempts?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'FamilyEntryGatewayError';
    this.code = code;
    this.remainingAttempts = details.remainingAttempts;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

export interface FamilySetupInput {
  displayName: string;
  familyName: string;
  grade: number;
  pin: string;
}

export interface FamilyEntryGateway {
  enterProfile(input: {
    deviceAccessToken: string;
    learningProfileId: string;
    pin: string;
  }): Promise<{ accessToken: string; expiresAt: string }>;
  listProfiles(deviceAccessToken: string): Promise<MobileLearningProfile[]>;
  logout(accessToken: string): Promise<void>;
  setupFamily(input: FamilySetupInput): Promise<{
    deviceAccessToken: string;
    profiles: MobileLearningProfile[];
  }>;
}

interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    remainingAttempts?: number;
    retryAfterSeconds?: number;
  };
}

function knownErrorCode(value: string | undefined): FamilyEntryErrorCode {
  return value === 'DEVICE_INVALID' ||
    value === 'IDENTITY_INVALID' ||
    value === 'PIN_INVALID' ||
    value === 'PIN_LOCKED' ||
    value === 'SESSION_EXPIRED' ||
    value === 'SESSION_INVALID'
    ? value
    : 'UNKNOWN';
}

export function createFamilyEntryGateway(
  baseUrl: string,
  identityAssertion: string,
): FamilyEntryGateway {
  const root = baseUrl.replace(/\/$/, '');

  async function request<Data>(path: string, options: RequestInit = {}): Promise<Data> {
    const response = await fetch(`${root}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const envelope = (await response.json().catch(() => ({}))) as ApiErrorEnvelope;
      const error = envelope.error;
      throw new FamilyEntryGatewayError(
        knownErrorCode(error?.code),
        error?.message ?? '请求暂时没有完成，请稍后重试',
        {
          ...(error?.remainingAttempts === undefined
            ? {}
            : { remainingAttempts: error.remainingAttempts }),
          ...(error?.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        },
      );
    }
    if (response.status === 204) {
      return undefined as Data;
    }
    const envelope = (await response.json()) as { data: Data };
    return envelope.data;
  }

  return {
    async setupFamily(input) {
      if (!identityAssertion) {
        throw new FamilyEntryGatewayError('IDENTITY_INVALID', '监护人登录服务尚未配置，请稍后再试');
      }
      const guardian = await request<{ accessToken: string }>('/v1/guardian-sessions', {
        body: JSON.stringify({ identityAssertion }),
        method: 'POST',
      });
      const authorization = { Authorization: `Bearer ${guardian.accessToken}` };
      const family = await request<{ id: string }>('/v1/family-spaces', {
        body: JSON.stringify({ name: input.familyName }),
        headers: authorization,
        method: 'POST',
      });
      const profile = await request<MobileLearningProfile>(
        `/v1/family-spaces/${family.id}/learning-profiles`,
        {
          body: JSON.stringify({
            displayName: input.displayName,
            grade: input.grade,
            pin: input.pin,
          }),
          headers: authorization,
          method: 'POST',
        },
      );
      const device = await request<{ accessToken: string }>(
        `/v1/family-spaces/${family.id}/devices`,
        {
          body: JSON.stringify({ label: '当前共享设备' }),
          headers: authorization,
          method: 'POST',
        },
      );
      await request<void>('/v1/session', {
        headers: authorization,
        method: 'DELETE',
      });
      return { deviceAccessToken: device.accessToken, profiles: [profile] };
    },
    listProfiles(deviceAccessToken) {
      return request<MobileLearningProfile[]>('/v1/device-learning-profiles', {
        headers: { Authorization: `Device ${deviceAccessToken}` },
      });
    },
    enterProfile(input) {
      return request<{ accessToken: string; expiresAt: string }>('/v1/learner-sessions', {
        body: JSON.stringify({
          learningProfileId: input.learningProfileId,
          pin: input.pin,
        }),
        headers: { Authorization: `Device ${input.deviceAccessToken}` },
        method: 'POST',
      });
    },
    logout(accessToken) {
      return request<void>('/v1/session', {
        headers: { Authorization: `Bearer ${accessToken}` },
        method: 'DELETE',
      });
    },
  };
}
