import type {
  DeviceRecord,
  ConsentEventRecord,
  ConsentRecord,
  FamilyAccessStore,
  GuardianRecord,
  LearningProfileRecord,
  SessionRecord,
} from './store.js';
import type { ConsentKind, FamilySpace, LearningProfile } from './types.js';

export class MemoryFamilyAccessStore implements FamilyAccessStore {
  readonly #consentEvents: ConsentEventRecord[] = [];
  readonly #consents = new Map<string, ConsentRecord>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #families = new Map<string, FamilySpace>();
  readonly #guardiansBySubject = new Map<string, GuardianRecord>();
  readonly #managingMemberships = new Set<string>();
  readonly #profiles = new Map<string, LearningProfileRecord>();
  readonly #sessions = new Map<string, SessionRecord>();

  async createDevice(record: DeviceRecord): Promise<void> {
    this.#devices.set(record.tokenHash, { ...record });
  }

  async createFamilyWithManagingGuardian(input: {
    familySpace: FamilySpace;
    guardianId: string;
  }): Promise<void> {
    this.#families.set(input.familySpace.id, { ...input.familySpace });
    this.#managingMemberships.add(`${input.guardianId}:${input.familySpace.id}`);
  }

  async createLearningProfile(profile: LearningProfileRecord): Promise<void> {
    this.#profiles.set(profile.id, { ...profile });
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.#sessions.set(session.tokenHash, { ...session, actor: { ...session.actor } });
  }

  async findConsent(familySpaceId: string, kind: ConsentKind): Promise<ConsentRecord | null> {
    const record = this.#consents.get(`${familySpaceId}:${kind}`);
    return record ? { ...record } : null;
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    const device = this.#devices.get(tokenHash);
    return device ? { ...device } : null;
  }

  async findGuardianByIdentitySubject(identitySubject: string): Promise<GuardianRecord | null> {
    const guardian = this.#guardiansBySubject.get(identitySubject);
    return guardian ? { ...guardian } : null;
  }

  async findLearningProfile(
    id: string,
    familySpaceId: string,
  ): Promise<LearningProfileRecord | null> {
    const profile = this.#profiles.get(id);
    return profile?.familySpaceId === familySpaceId ? { ...profile } : null;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.#sessions.get(tokenHash);
    return session ? { ...session, actor: { ...session.actor } } : null;
  }

  async isManagingGuardian(guardianId: string, familySpaceId: string): Promise<boolean> {
    return this.#managingMemberships.has(`${guardianId}:${familySpaceId}`);
  }

  async listLearningProfiles(familySpaceId: string): Promise<LearningProfile[]> {
    return [...this.#profiles.values()]
      .filter((profile) => profile.familySpaceId === familySpaceId)
      .map(({ displayName, familySpaceId: familyId, grade, id }) => ({
        displayName,
        familySpaceId: familyId,
        grade,
        id,
      }));
  }

  async listConsentEvents(familySpaceId: string, kind: ConsentKind): Promise<ConsentEventRecord[]> {
    return this.#consentEvents
      .filter((event) => event.familySpaceId === familySpaceId && event.kind === kind)
      .sort((left, right) => left.revision - right.revision)
      .map((event) => ({ ...event }));
  }

  async listConsentRecords(familySpaceId: string): Promise<ConsentRecord[]> {
    return [...this.#consents.values()]
      .filter((record) => record.familySpaceId === familySpaceId)
      .map((record) => ({ ...record }));
  }

  async markSessionReverified(tokenHash: string, reverifiedAt: Date): Promise<boolean> {
    const session = this.#sessions.get(tokenHash);
    if (!session || session.revokedAt || session.actor.type !== 'guardian') {
      return false;
    }
    session.reverifiedAt = reverifiedAt;
    return true;
  }

  async revokeSession(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const session = this.#sessions.get(tokenHash);
    if (!session || session.revokedAt) {
      return false;
    }
    session.revokedAt = revokedAt;
    return true;
  }

  async savePinState(input: {
    failedPinAttempts: number;
    familySpaceId: string;
    learningProfileId: string;
    pinLockedUntil: Date | null;
  }): Promise<void> {
    const profile = this.#profiles.get(input.learningProfileId);
    if (!profile || profile.familySpaceId !== input.familySpaceId) {
      return;
    }
    profile.failedPinAttempts = input.failedPinAttempts;
    profile.pinLockedUntil = input.pinLockedUntil;
  }

  async saveConsentDecision(record: ConsentRecord, event: ConsentEventRecord): Promise<void> {
    this.#consents.set(`${record.familySpaceId}:${record.kind}`, { ...record });
    this.#consentEvents.push({ ...event });
  }

  async upsertGuardian(identitySubject: string, proposedId: string): Promise<GuardianRecord> {
    const existing = this.#guardiansBySubject.get(identitySubject);
    if (existing) {
      return { ...existing };
    }
    const guardian = { id: proposedId, identitySubject };
    this.#guardiansBySubject.set(identitySubject, guardian);
    return { ...guardian };
  }
}
