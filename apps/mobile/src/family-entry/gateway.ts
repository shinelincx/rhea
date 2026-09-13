export interface MobileLearningProfile {
  displayName: string;
  familySpaceId: string;
  grade: number | null;
  id: string;
}

export type MobileConsentKind =
  'photo_processing' | 'ai_processing' | 'peer_challenge' | 'notifications';

export type MobileConsentStatus = 'not_decided' | 'granted' | 'denied' | 'withdrawn';

export interface MobileConsent {
  dataScope: string[];
  familySpaceId: string;
  kind: MobileConsentKind;
  purpose: string;
  revision: number;
  statementVersion: string;
  status: MobileConsentStatus;
  updatedAt: string | null;
}

export type FamilyEntryErrorCode =
  | 'CONSENT_REQUIRED'
  | 'DEVICE_INVALID'
  | 'GUARDIAN_REVERIFICATION_REQUIRED'
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

export interface MobilePrivacyTask {
  completedAt: string | null;
  deadlineAt: string;
  errorCode: string | null;
  id: string;
  kind: 'erasure' | 'export';
  status: 'completed' | 'failed' | 'pending' | 'processing' | 'retry_scheduled';
}

export interface MobileErasurePreview {
  confirmationText: string;
  deadlineDays: 30;
  effects: string[];
}
export interface MobileErasureCertificate {
  completedAt: string;
  id: string;
  statement: string;
  targetNames: string[];
  taskId: string;
}
export interface MobileExportDownload {
  fileName: string;
  generatedAt: string;
  payload: unknown;
}

export interface FamilyEntryGateway {
  changeConsent(input: {
    accessToken: string;
    familySpaceId: string;
    granted: boolean;
    kind: MobileConsentKind;
  }): Promise<MobileConsent>;
  enterProfile(input: {
    deviceAccessToken: string;
    learningProfileId: string;
    pin: string;
  }): Promise<{ accessToken: string; expiresAt: string }>;
  listProfiles(deviceAccessToken: string): Promise<MobileLearningProfile[]>;
  openGuardianSettings(familySpaceId: string): Promise<{
    accessToken: string;
    consents: MobileConsent[];
  }>;
  logout(accessToken: string): Promise<void>;
  getPrivacyTask?(input: {
    accessToken: string;
    familySpaceId: string;
    taskId: string;
  }): Promise<MobilePrivacyTask>;
  getErasureCertificate?(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
    taskId: string;
  }): Promise<MobileErasureCertificate>;
  previewErasure?(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<MobileErasurePreview>;
  requestErasure?(input: {
    accessToken: string;
    confirmationText: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<MobilePrivacyTask>;
  requestExport?(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<MobilePrivacyTask>;
  downloadExport?(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
    taskId: string;
  }): Promise<MobileExportDownload>;
  grantSupportAccess?(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
    reason: string;
    supportPrincipalId: string;
  }): Promise<{ expiresAt: string; id: string }>;
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
  return value === 'CONSENT_REQUIRED' ||
    value === 'DEVICE_INVALID' ||
    value === 'GUARDIAN_REVERIFICATION_REQUIRED' ||
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

  async function reverify(accessToken: string) {
    if (!identityAssertion)
      throw new FamilyEntryGatewayError('IDENTITY_INVALID', '监护人登录服务尚未配置，请稍后再试');
    await request('/v1/guardian-reverification', {
      body: JSON.stringify({ identityAssertion }),
      headers: { Authorization: `Bearer ${accessToken}` },
      method: 'POST',
    });
  }

  return {
    async openGuardianSettings(familySpaceId) {
      if (!identityAssertion) {
        throw new FamilyEntryGatewayError('IDENTITY_INVALID', '监护人登录服务尚未配置，请稍后再试');
      }
      const guardian = await request<{ accessToken: string }>('/v1/guardian-sessions', {
        body: JSON.stringify({ identityAssertion }),
        method: 'POST',
      });
      try {
        const consents = await request<MobileConsent[]>(
          `/v1/family-spaces/${familySpaceId}/consents`,
          { headers: { Authorization: `Bearer ${guardian.accessToken}` } },
        );
        return { accessToken: guardian.accessToken, consents };
      } catch (error) {
        await request<void>('/v1/session', {
          headers: { Authorization: `Bearer ${guardian.accessToken}` },
          method: 'DELETE',
        }).catch(() => undefined);
        throw error;
      }
    },
    async changeConsent(input) {
      if (!identityAssertion) {
        throw new FamilyEntryGatewayError('IDENTITY_INVALID', '监护人登录服务尚未配置，请稍后再试');
      }
      const authorization = { Authorization: `Bearer ${input.accessToken}` };
      await reverify(input.accessToken);
      return request<MobileConsent>(
        `/v1/family-spaces/${input.familySpaceId}/consents/${input.kind}`,
        {
          body: JSON.stringify({ granted: input.granted }),
          headers: authorization,
          method: 'PUT',
        },
      );
    },
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
    async previewErasure(input) {
      await reverify(input.accessToken);
      return request<MobileErasurePreview>(
        `/v1/family-spaces/${input.familySpaceId}/learning-profiles/${input.learningProfileId}/erasure-preview`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      );
    },
    async requestExport(input) {
      await reverify(input.accessToken);
      return request<MobilePrivacyTask>(
        `/v1/family-spaces/${input.familySpaceId}/learning-profiles/${input.learningProfileId}/exports`,
        { headers: { Authorization: `Bearer ${input.accessToken}` }, method: 'POST' },
      );
    },
    async getPrivacyTask(input) {
      await reverify(input.accessToken);
      return request<MobilePrivacyTask>(
        `/v1/family-spaces/${input.familySpaceId}/privacy-tasks/${input.taskId}`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      );
    },
    async getErasureCertificate(input) {
      await reverify(input.accessToken);
      return request<MobileErasureCertificate>(
        `/v1/family-spaces/${input.familySpaceId}/learning-profiles/${input.learningProfileId}/privacy-tasks/${input.taskId}/certificate`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      );
    },
    async downloadExport(input) {
      await reverify(input.accessToken);
      return request<MobileExportDownload>(
        `/v1/family-spaces/${input.familySpaceId}/learning-profiles/${input.learningProfileId}/exports/${input.taskId}/download`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      );
    },
    async requestErasure(input) {
      await reverify(input.accessToken);
      return request<MobilePrivacyTask>(
        `/v1/family-spaces/${input.familySpaceId}/learning-profiles/${input.learningProfileId}/erasure`,
        {
          body: JSON.stringify({ confirmationText: input.confirmationText }),
          headers: { Authorization: `Bearer ${input.accessToken}` },
          method: 'POST',
        },
      );
    },
    async grantSupportAccess(input) {
      await reverify(input.accessToken);
      return request<{ expiresAt: string; id: string }>(
        `/v1/family-spaces/${input.familySpaceId}/learning-profiles/${input.learningProfileId}/support-access-grants`,
        {
          body: JSON.stringify({
            durationMinutes: 60,
            reason: input.reason,
            scopes: ['processing_status', 'technical_metadata'],
            supportPrincipalId: input.supportPrincipalId,
          }),
          headers: { Authorization: `Bearer ${input.accessToken}` },
          method: 'POST',
        },
      );
    },
  };
}
