export type Grade = 1 | 2 | 3 | 4 | 5 | 6;

export type Capability =
  | 'challenge.use'
  | 'consent.manage'
  | 'data.erase'
  | 'data.export'
  | 'family.manage'
  | 'learning.read'
  | 'learning.submit'
  | 'review.use'
  | 'support_access.manage'
  | 'today.read';

export interface GuardianActor {
  guardianId: string;
  type: 'guardian';
}

export interface LearnerActor {
  deviceId: string;
  familySpaceId: string;
  learningProfileId: string;
  type: 'learner';
}

export type Actor = GuardianActor | LearnerActor;

export type ConsentKind = 'photo_processing' | 'ai_processing' | 'peer_challenge' | 'notifications';

export type ConsentStatus = 'not_decided' | 'granted' | 'denied' | 'withdrawn';

export interface ConsentView {
  dataScope: string[];
  familySpaceId: string;
  kind: ConsentKind;
  purpose: string;
  revision: number;
  statementVersion: string;
  status: ConsentStatus;
  updatedAt: string | null;
}

export interface ConsentHistoryEntry {
  occurredAt: string;
  previousStatus: ConsentStatus | null;
  revision: number;
  statementVersion: string;
  status: Exclude<ConsentStatus, 'not_decided'>;
}

export interface Clock {
  readonly now: Date;
}

export interface IdentityProviderPort {
  verify(identityAssertion: string): Promise<{ subject: string }>;
}

export interface SessionGrant {
  accessToken: string;
  actor: Actor;
  expiresAt: string;
}

export interface FamilySpace {
  id: string;
  name: string;
}

export interface LearningProfile {
  displayName: string;
  familySpaceId: string;
  grade: Grade | null;
  id: string;
}

export interface RegisteredDeviceGrant {
  accessToken: string;
  familySpaceId: string;
  id: string;
  label: string;
}

export interface FamilyAccess {
  authorize(input: { accessToken: string; capability: Capability }): Promise<Actor>;
  authorizeLearningProfile(input: {
    accessToken: string;
    capability: 'learning.read' | 'learning.submit';
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<Actor>;
  authorizeSensitive(input: {
    accessToken: string;
    capability: 'data.erase' | 'data.export' | 'support_access.manage';
    familySpaceId: string;
  }): Promise<GuardianActor>;
  changeConsent(input: {
    accessToken: string;
    familySpaceId: string;
    granted: boolean;
    kind: ConsentKind;
  }): Promise<ConsentView>;
  createFamilySpace(input: { accessToken: string; name: string }): Promise<FamilySpace>;
  createLearningProfile(input: {
    accessToken: string;
    displayName: string;
    familySpaceId: string;
    grade: number | null;
    pin: string;
  }): Promise<LearningProfile>;
  getSession(input: { accessToken: string }): Promise<{ actor: Actor; expiresAt: string }>;
  issueLearnerSession(input: {
    deviceAccessToken: string;
    learningProfileId: string;
    pin: string;
  }): Promise<SessionGrant>;
  listConsentHistory(input: {
    accessToken: string;
    familySpaceId: string;
    kind: ConsentKind;
  }): Promise<ConsentHistoryEntry[]>;
  listConsents(input: { accessToken: string; familySpaceId: string }): Promise<ConsentView[]>;
  listDeviceProfiles(input: { deviceAccessToken: string }): Promise<LearningProfile[]>;
  loginGuardian(input: { identityAssertion: string }): Promise<SessionGrant>;
  logout(input: { accessToken: string }): Promise<void>;
  registerDevice(input: {
    accessToken: string;
    familySpaceId: string;
    label: string;
  }): Promise<RegisteredDeviceGrant>;
  requireConsent(input: {
    accessToken: string;
    familySpaceId: string;
    kind: ConsentKind;
  }): Promise<ConsentView>;
  reverifyGuardian(input: {
    accessToken: string;
    identityAssertion: string;
  }): Promise<{ reverifiedAt: string; validUntil: string }>;
}
