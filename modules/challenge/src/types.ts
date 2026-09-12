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
  evidenceQualification: 'assisted_only';
  id: string;
  items: ChallengeItemView[];
  knowledgeFeedback: Array<{
    correctItems: number;
    knowledgePoint: string;
    totalItems: number;
  }>;
  myProgress: { completedItems: number; totalItems: number };
  noPenalty: boolean;
  opponentProgress: { completedItems: number; totalItems: number };
  relationId: string;
  score: null | { accuracy: number; correctItems: number; totalItems: number };
  speedAffectsScore: false;
  status: 'active' | 'cancelled' | 'completed';
  subject: ChallengeSubject;
  target: string;
}
