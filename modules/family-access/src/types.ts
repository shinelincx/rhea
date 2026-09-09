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
  listDeviceProfiles(input: { deviceAccessToken: string }): Promise<LearningProfile[]>;
  loginGuardian(input: { identityAssertion: string }): Promise<SessionGrant>;
  logout(input: { accessToken: string }): Promise<void>;
  registerDevice(input: {
    accessToken: string;
    familySpaceId: string;
    label: string;
  }): Promise<RegisteredDeviceGrant>;
}
