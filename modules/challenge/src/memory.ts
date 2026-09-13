import type {
  ChallengeAuthorizationPort,
  ChallengeAuthorizationSnapshot,
  ChallengeMatchPoolEntry,
  ChallengeMatchPoolOutcome,
  ChallengeMatchPoolPort,
} from './types.js';
import type {
  ChallengeRecord,
  ChallengeStore,
  ConsumeInviteResult,
  DeidentifiedChallengeResult,
  PartnerInviteRecord,
  PartnerRelationRecord,
} from './store.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryChallengeAuthorization implements ChallengeAuthorizationPort {
  readonly #snapshots = new Map<string, ChallengeAuthorizationSnapshot>();

  constructor(snapshots: ChallengeAuthorizationSnapshot[] = []) {
    snapshots.forEach((snapshot) => this.set(snapshot));
  }

  set(snapshot: ChallengeAuthorizationSnapshot): void {
    this.#snapshots.set(snapshot.learningProfileId, clone(snapshot));
  }

  async getChallengeAuthorization(input: { learningProfileId: string }) {
    return clone(this.#snapshots.get(input.learningProfileId) ?? null);
  }
}

export class MemoryChallengeMatchPool implements ChallengeMatchPoolPort {
  readonly #entries = new Map<number, Map<string, ChallengeMatchPoolEntry>>();

  async enter(entry: ChallengeMatchPoolEntry): Promise<ChallengeMatchPoolOutcome> {
    const gradeEntries = this.#entries.get(entry.grade) ?? new Map();
    this.#entries.set(entry.grade, gradeEntries);
    const existing = gradeEntries.get(entry.actor.learningProfileId);
    if (existing) return { kind: 'waiting' };
    const opponent = [...gradeEntries.values()].find(
      (candidate) => candidate.actor.learningProfileId !== entry.actor.learningProfileId,
    );
    if (!opponent) {
      gradeEntries.set(entry.actor.learningProfileId, clone(entry));
      return { kind: 'waiting' };
    }
    gradeEntries.delete(opponent.actor.learningProfileId);
    return { kind: 'candidate', opponent: clone(opponent) };
  }

  async remove(entry: ChallengeMatchPoolEntry): Promise<void> {
    this.#entries.get(entry.grade)?.delete(entry.actor.learningProfileId);
  }

  async restore(entries: ChallengeMatchPoolEntry[]): Promise<void> {
    for (const entry of entries) {
      const gradeEntries = this.#entries.get(entry.grade) ?? new Map();
      this.#entries.set(entry.grade, gradeEntries);
      gradeEntries.set(entry.actor.learningProfileId, clone(entry));
    }
  }
}

export class MemoryChallengeStore implements ChallengeStore {
  readonly #challenges = new Map<string, ChallengeRecord>();
  readonly #invites = new Map<string, PartnerInviteRecord>();
  readonly #matchEntries = new Map<string, ChallengeMatchPoolEntry>();
  readonly #relations = new Map<string, PartnerRelationRecord>();
  readonly #results = new Map<string, DeidentifiedChallengeResult>();
  readonly #avoidanceTokens = new Set<string>();
  readonly #identityMappings = new Map<string, ChallengeRecord['identities']>();

  async saveInvite(record: PartnerInviteRecord): Promise<void> {
    this.#invites.set(record.codeHash, clone(record));
  }

  async findInviteByHash(codeHash: string): Promise<PartnerInviteRecord | null> {
    return clone(this.#invites.get(codeHash) ?? null);
  }

  async consumeInvite(input: {
    authorizationSnapshots: Array<{
      consentRevision: number;
      familySpaceId: string;
      grade: number;
      learningProfileId: string;
    }>;
    codeHash: string;
    consumedAt: string;
    inviteId: string;
    relation: PartnerRelationRecord;
  }): Promise<ConsumeInviteResult> {
    const invite = this.#invites.get(input.codeHash);
    if (!invite || invite.id !== input.inviteId) return { kind: 'not_found' };
    if (invite.consumedAt) return { kind: 'already_used' };
    if (Date.parse(invite.expiresAt) <= Date.parse(input.consumedAt)) return { kind: 'expired' };
    invite.consumedAt = input.consumedAt;
    invite.relationId = input.relation.id;
    this.#relations.set(input.relation.id, clone(input.relation));
    return { kind: 'consumed', relation: clone(input.relation) };
  }

  async findRelation(
    id: string,
    _learningProfileId: string,
  ): Promise<PartnerRelationRecord | null> {
    return clone(this.#relations.get(id) ?? null);
  }

  async listRelations(learningProfileId: string): Promise<PartnerRelationRecord[]> {
    return [...this.#relations.values()]
      .filter((relation) =>
        relation.participants.some((entry) => entry.learningProfileId === learningProfileId),
      )
      .map(clone);
  }

  async saveRelation(record: PartnerRelationRecord): Promise<void> {
    this.#relations.set(record.id, clone(record));
  }

  async saveChallenge(record: ChallengeRecord, expectedVersion: number | null): Promise<boolean> {
    const current = this.#challenges.get(record.id);
    if (expectedVersion === null ? Boolean(current) : current?.version !== expectedVersion) {
      return false;
    }
    if (
      expectedVersion === null &&
      record.mode === 'partner' &&
      (!record.relationId || this.#relations.get(record.relationId)?.status !== 'active')
    ) {
      return false;
    }
    this.#challenges.set(record.id, clone(record));
    return true;
  }

  async getChallenge(id: string, _learningProfileId: string): Promise<ChallengeRecord | null> {
    return clone(this.#challenges.get(id) ?? null);
  }

  async listChallenges(learningProfileId: string): Promise<ChallengeRecord[]> {
    return [...this.#challenges.values()]
      .filter((challenge) =>
        challenge.packs.some((pack) => pack.learningProfileId === learningProfileId),
      )
      .map(clone);
  }

  async saveMatchPoolEntry(entry: ChallengeMatchPoolEntry): Promise<boolean> {
    if (
      [...this.#challenges.values()].some(
        (challenge) =>
          challenge.mode === 'random' &&
          challenge.status === 'active' &&
          challenge.packs.some((pack) => pack.learningProfileId === entry.actor.learningProfileId),
      )
    ) {
      return false;
    }
    this.#matchEntries.set(entry.entryId, clone(entry));
    return true;
  }

  async saveRandomChallenge(
    record: ChallengeRecord,
    entries: ChallengeMatchPoolEntry[],
  ): Promise<'avoided' | 'conflict' | 'created'> {
    if (!record.pairAvoidanceToken || this.#avoidanceTokens.has(record.pairAvoidanceToken)) {
      return 'avoided';
    }
    if (this.#challenges.has(record.id)) return 'conflict';
    this.#challenges.set(record.id, clone(record));
    this.#identityMappings.set(record.id, clone(record.identities));
    entries.forEach((entry) => this.#matchEntries.delete(entry.entryId));
    return 'created';
  }

  async finalizeRandomChallenge(input: {
    challenge: ChallengeRecord;
    expectedVersion: number;
    reportedByProfileId: string | null;
    reportReason: string | null;
    results: DeidentifiedChallengeResult[];
  }): Promise<boolean> {
    const current = this.#challenges.get(input.challenge.id);
    if (!current || current.version !== input.expectedVersion || current.mode !== 'random') {
      return false;
    }
    if (input.reportedByProfileId && input.challenge.pairAvoidanceToken) {
      this.#avoidanceTokens.add(input.challenge.pairAvoidanceToken);
    }
    input.results.forEach((result) =>
      this.#results.set(`${result.challengeId}:${result.owner.learningProfileId}`, clone(result)),
    );
    this.#challenges.delete(input.challenge.id);
    this.#identityMappings.delete(input.challenge.id);
    return true;
  }

  async getChallengeResult(
    id: string,
    learningProfileId: string,
  ): Promise<DeidentifiedChallengeResult | null> {
    return clone(this.#results.get(`${id}:${learningProfileId}`) ?? null);
  }

  async listChallengeResults(learningProfileId: string): Promise<DeidentifiedChallengeResult[]> {
    return [...this.#results.values()]
      .filter((result) => result.owner.learningProfileId === learningProfileId)
      .map(clone);
  }

  async listDueRandomChallenges(dueAt: string, limit: number): Promise<ChallengeRecord[]> {
    return [...this.#challenges.values()]
      .filter(
        (challenge) =>
          challenge.mode === 'random' &&
          challenge.status === 'active' &&
          challenge.expiresAt !== null &&
          challenge.expiresAt <= dueAt,
      )
      .slice(0, limit)
      .map(clone);
  }

  debugState() {
    return clone({
      challenges: [...this.#challenges.values()],
      avoidanceTokens: [...this.#avoidanceTokens],
      identityMappings: [...this.#identityMappings.values()],
      invites: [...this.#invites.values()],
      matchEntries: [...this.#matchEntries.values()],
      relations: [...this.#relations.values()],
      results: [...this.#results.values()],
    });
  }
}
