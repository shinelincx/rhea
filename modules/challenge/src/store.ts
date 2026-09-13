import type {
  ChallengeActor,
  ChallengeGeneratedPack,
  ChallengeMatchPoolEntry,
  ChallengeSubject,
  ChallengeView,
  PartnerRelationView,
} from './types.js';

export interface PartnerInviteRecord {
  codeHash: string;
  consumedAt: string | null;
  createdAt: string;
  creator: ChallengeActor;
  expiresAt: string;
  id: string;
  relationId: string | null;
}

export interface PartnerRelationRecord extends PartnerRelationView {
  createdAt: string;
}

export interface ChallengeAnswerRecord {
  answer: string;
  commandId: string;
  correct: boolean;
  itemId: string;
  learningProfileId: string;
  submittedAt: string;
}

export interface ChallengeRecord {
  answers: ChallengeAnswerRecord[];
  authorizationDecisionId: string;
  authorizationSnapshots: Array<{
    consentRevision: number;
    familySpaceId: string;
    grade: number;
    learningProfileId: string;
  }>;
  capabilityVersionId: string;
  cancelledAt: string | null;
  cancelledByProfileId: string | null;
  createdAt: string;
  endedReason: ChallengeView['endedReason'];
  expiresAt: string | null;
  id: string;
  identities: Array<{
    avatarKey: string;
    learningProfileId: string;
    nickname: string;
  }>;
  mode: 'partner' | 'random';
  packs: ChallengeGeneratedPack[];
  pairAvoidanceToken: string | null;
  relationId: string | null;
  status: 'active' | 'cancelled' | 'completed';
  subject: ChallengeSubject;
  target: string;
  version: number;
}

export interface DeidentifiedChallengeResult {
  challengeId: string;
  endedAt: string;
  owner: ChallengeActor;
  view: ChallengeView;
}

export type SaveRandomChallengeResult = 'avoided' | 'conflict' | 'created';

export type ConsumeInviteResult =
  | { kind: 'consumed'; relation: PartnerRelationRecord }
  | { kind: 'already_used' }
  | { kind: 'expired' }
  | { kind: 'not_found' };

export interface ChallengeStore {
  consumeInvite(input: {
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
  }): Promise<ConsumeInviteResult>;
  findInviteByHash(codeHash: string): Promise<PartnerInviteRecord | null>;
  findRelation(id: string, learningProfileId: string): Promise<PartnerRelationRecord | null>;
  getChallenge(id: string, learningProfileId: string): Promise<ChallengeRecord | null>;
  getChallengeResult(
    id: string,
    learningProfileId: string,
  ): Promise<DeidentifiedChallengeResult | null>;
  finalizeRandomChallenge(input: {
    challenge: ChallengeRecord;
    expectedVersion: number;
    reportedByProfileId: string | null;
    reportReason: string | null;
    results: DeidentifiedChallengeResult[];
  }): Promise<boolean>;
  listChallenges(learningProfileId: string): Promise<ChallengeRecord[]>;
  listChallengeResults(learningProfileId: string): Promise<DeidentifiedChallengeResult[]>;
  listDueRandomChallenges(dueAt: string, limit: number): Promise<ChallengeRecord[]>;
  listRelations(learningProfileId: string): Promise<PartnerRelationRecord[]>;
  saveChallenge(record: ChallengeRecord, expectedVersion: number | null): Promise<boolean>;
  saveInvite(record: PartnerInviteRecord): Promise<void>;
  saveMatchPoolEntry(entry: ChallengeMatchPoolEntry): Promise<boolean>;
  saveRandomChallenge(
    record: ChallengeRecord,
    entries: ChallengeMatchPoolEntry[],
  ): Promise<SaveRandomChallengeResult>;
  saveRelation(record: PartnerRelationRecord): Promise<void>;
}
