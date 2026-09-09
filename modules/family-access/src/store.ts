import type { Actor, ConsentKind, ConsentStatus, FamilySpace, LearningProfile } from './types.js';

export interface GuardianRecord {
  id: string;
  identitySubject: string;
}

export interface SessionRecord {
  actor: Actor;
  expiresAt: Date;
  id: string;
  reverifiedAt: Date | null;
  revokedAt: Date | null;
  tokenHash: string;
}

export interface ConsentRecord {
  familySpaceId: string;
  guardianId: string;
  kind: ConsentKind;
  revision: number;
  statementVersion: string;
  status: Exclude<ConsentStatus, 'not_decided'>;
  updatedAt: Date;
}

export interface ConsentEventRecord extends ConsentRecord {
  id: string;
  previousStatus: ConsentStatus | null;
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
  createLearningProfile(input: {
    editorGuardianId: string;
    profile: LearningProfileRecord;
  }): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  findConsent(familySpaceId: string, kind: ConsentKind): Promise<ConsentRecord | null>;
  findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  findGuardianByIdentitySubject(identitySubject: string): Promise<GuardianRecord | null>;
  findLearningProfile(id: string, familySpaceId: string): Promise<LearningProfileRecord | null>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  isManagingGuardian(guardianId: string, familySpaceId: string): Promise<boolean>;
  canEditLearningContent(input: {
    familySpaceId: string;
    guardianId: string;
    learningProfileId: string;
  }): Promise<boolean>;
  listLearningProfiles(familySpaceId: string): Promise<LearningProfile[]>;
  listConsentEvents(familySpaceId: string, kind: ConsentKind): Promise<ConsentEventRecord[]>;
  listConsentRecords(familySpaceId: string): Promise<ConsentRecord[]>;
  markSessionReverified(tokenHash: string, reverifiedAt: Date): Promise<boolean>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean>;
  savePinState(input: {
    failedPinAttempts: number;
    familySpaceId: string;
    learningProfileId: string;
    pinLockedUntil: Date | null;
  }): Promise<void>;
  saveConsentDecision(record: ConsentRecord, event: ConsentEventRecord): Promise<void>;
  upsertGuardian(identitySubject: string, proposedId: string): Promise<GuardianRecord>;
}
