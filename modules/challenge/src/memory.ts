import type { ChallengeAuthorizationPort, ChallengeAuthorizationSnapshot } from './types.js';
import type {
  ChallengeRecord,
  ChallengeStore,
  ConsumeInviteResult,
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

export class MemoryChallengeStore implements ChallengeStore {
  readonly #challenges = new Map<string, ChallengeRecord>();
  readonly #invites = new Map<string, PartnerInviteRecord>();
  readonly #relations = new Map<string, PartnerRelationRecord>();

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
    if (expectedVersion === null && this.#relations.get(record.relationId)?.status !== 'active') {
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

  debugState() {
    return clone({
      challenges: [...this.#challenges.values()],
      invites: [...this.#invites.values()],
      relations: [...this.#relations.values()],
    });
  }
}
