export type ChallengeSubject = 'chinese' | 'english' | 'mathematics' | 'science';
export type ChallengeDifficulty = 'foundation' | 'practice' | 'transfer';

export interface ChallengeActor {
  familySpaceId: string;
  learningProfileId: string;
}

export interface ChallengeAuthorizationSnapshot extends ChallengeActor {
  consentRevision: number;
  grade: number | null;
  status: 'denied' | 'granted' | 'not_decided' | 'withdrawn';
}

export interface ChallengeAuthorizationPort {
  getChallengeAuthorization(actor: ChallengeActor): Promise<ChallengeAuthorizationSnapshot | null>;
}

export type ChallengeGradingRule =
  | { expected: string; kind: 'numeric' }
  | { correctOptionId: string; kind: 'single_choice' }
  | { acceptedAnswers: string[]; kind: 'accepted_text' };

export interface ChallengeGeneratedItem {
  difficulty: ChallengeDifficulty;
  gradingRule: ChallengeGradingRule;
  id: string;
  knowledgePoint: string;
  options?: Array<{ id: string; text: string }>;
  prompt: string;
}

export interface ChallengeGeneratedPack {
  items: ChallengeGeneratedItem[];
  learningProfileId: string;
}

export interface ChallengePackFactory {
  createEquivalentPacks(input: {
    grade: number;
    participants: ChallengeActor[];
    subject: ChallengeSubject;
    target: string;
  }): Promise<{
    authorizationDecisionId: string;
    capabilityVersionId: string;
    packs: ChallengeGeneratedPack[];
  }>;
}

export interface PartnerInviteView {
  code: string;
  expiresAt: string;
}

export interface PartnerRelationView {
  dissolvedAt: string | null;
  id: string;
  participants: ChallengeActor[];
  status: 'active' | 'dissolved';
}

export interface ChallengeItemView {
  difficulty: ChallengeDifficulty;
  id: string;
  knowledgePoint: string;
  options: Array<{ id: string; text: string }> | null;
  prompt: string;
  response: null | { answer: string; correct: boolean; submittedAt: string };
}

export interface ChallengeView {
  authorizationDecisionId: string;
  capabilityVersionId: string;
  createdAt: string;
  endedReason:
    | 'authorization_withdrawn'
    | 'completed'
    | 'expired'
    | 'left'
    | 'relation_dissolved'
    | 'reported'
    | null;
  evidenceQualification: 'assisted_only';
  expiresAt: string | null;
  id: string;
  items: ChallengeItemView[];
  knowledgeFeedback: Array<{
    correctItems: number;
    knowledgePoint: string;
    totalItems: number;
  }>;
  myProgress: { completedItems: number; totalItems: number };
  mode: 'partner' | 'random';
  noPenalty: boolean;
  opponentIdentity: { avatarKey: string; nickname: string } | null;
  opponentProgress: { completedItems: number; totalItems: number };
  relationId: string | null;
  score: null | { accuracy: number; correctItems: number; totalItems: number };
  speedAffectsScore: false;
  status: 'active' | 'cancelled' | 'completed';
  subject: ChallengeSubject;
  target: string;
}

export interface ChallengeMatchPoolEntry {
  actor: ChallengeActor;
  enteredAt: string;
  entryId: string;
  expiresAt: string;
  grade: number;
}

export type ChallengeMatchPoolOutcome =
  { kind: 'candidate'; opponent: ChallengeMatchPoolEntry } | { kind: 'waiting' };

export interface ChallengeMatchPoolPort {
  enter(entry: ChallengeMatchPoolEntry): Promise<ChallengeMatchPoolOutcome>;
  remove(entry: ChallengeMatchPoolEntry): Promise<void>;
  restore(entries: ChallengeMatchPoolEntry[]): Promise<void>;
}

export type MatchPoolView =
  | { entryId: string; expiresAt: string; grade: number; status: 'waiting' }
  | { challenge: ChallengeView; grade: number; status: 'matched' };

export type RandomChallengeReportReason =
  'other_preset' | 'suspected_cheating' | 'uncomfortable' | 'unsafe_content';
