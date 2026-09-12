import type {
  ChallengeActor,
  ChallengeGeneratedPack,
  ChallengeSubject,
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
  id: string;
  packs: ChallengeGeneratedPack[];
  relationId: string;
  status: 'active' | 'cancelled' | 'completed';
  subject: ChallengeSubject;
  target: string;
  version: number;
}

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
  listChallenges(learningProfileId: string): Promise<ChallengeRecord[]>;
  listRelations(learningProfileId: string): Promise<PartnerRelationRecord[]>;
  saveChallenge(record: ChallengeRecord, expectedVersion: number | null): Promise<boolean>;
  saveInvite(record: PartnerInviteRecord): Promise<void>;
  saveRelation(record: PartnerRelationRecord): Promise<void>;
}
