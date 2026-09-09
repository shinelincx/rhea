import type { Actor, FamilySpace, LearningProfile } from './types.js';

export interface GuardianRecord {
  id: string;
  identitySubject: string;
}

export interface SessionRecord {
  actor: Actor;
  expiresAt: Date;
  id: string;
  revokedAt: Date | null;
  tokenHash: string;
}

export interface DeviceRecord {
  familySpaceId: string;
  id: string;
  label: string;
  revokedAt: Date | null;
  tokenHash: string;
}

export interface LearningProfileRecord extends LearningProfile {
  failedPinAttempts: number;
  pinHash: string;
  pinLockedUntil: Date | null;
}

export interface FamilyAccessStore {
  createDevice(record: DeviceRecord): Promise<void>;
  createFamilyWithManagingGuardian(input: {
    familySpace: FamilySpace;
    guardianId: string;
  }): Promise<void>;
  createLearningProfile(profile: LearningProfileRecord): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  findLearningProfile(id: string, familySpaceId: string): Promise<LearningProfileRecord | null>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  isManagingGuardian(guardianId: string, familySpaceId: string): Promise<boolean>;
  listLearningProfiles(familySpaceId: string): Promise<LearningProfile[]>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean>;
  savePinState(input: {
    failedPinAttempts: number;
    familySpaceId: string;
    learningProfileId: string;
    pinLockedUntil: Date | null;
  }): Promise<void>;
  upsertGuardian(identitySubject: string, proposedId: string): Promise<GuardianRecord>;
}
