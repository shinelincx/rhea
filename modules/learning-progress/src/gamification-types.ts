export type GamificationAuthorityState =
  'accepted_current' | 'disputed' | 'expired' | 'invalidated' | 'pending' | 'shadow';

export type GamificationEventKind =
  | 'learning_evidence_assisted'
  | 'learning_evidence_independent'
  | 'review_completed'
  | 'safe_challenge_completed';

export interface GamificationScope {
  familySpaceId: string;
  learningProfileId: string;
}

export interface GamificationEvent extends GamificationScope {
  authorityState: GamificationAuthorityState;
  eventKey: string;
  expiresAt: string | null;
  kind: GamificationEventKind;
  learningDate: string;
  occurredAt: string;
  sourceReferenceId: string;
  sourceVersion: string;
}

export interface GrowthComponentView {
  contribution: number;
  earnedUnits: number;
  explanation: string;
  maximumContribution: number;
  name: 'learning_evidence' | 'review_consistency' | 'safe_participation';
  weight: 60 | 30 | 10;
}

export interface GrowthBadgeView {
  description: string;
  key: 'first_step' | 'review_rhythm' | 'safe_participant' | 'steady_growth';
  label: string;
}

export interface GrowthView {
  badges: GrowthBadgeView[];
  components: GrowthComponentView[];
  excludedEvents: {
    disputed: number;
    expired: number;
    invalidated: number;
    pending: number;
    shadow: number;
  };
  generatedAt: string;
  growthScore: number;
  learningProfileId: string;
  level: number;
  nextLevelAtXp: number;
  policy: {
    learningAccess: 'always_available';
    personalInformationRequired: false;
    purchaseRequired: false;
    ranking: 'none';
    speedAffectsScore: false;
  };
  policyVersion: 'growth-v1';
  streak: { bestDays: number; currentDays: number; message: string };
  xp: number;
}

export type RecordGamificationEventResult =
  | { event: GamificationEvent; status: 'recorded' }
  | { event: GamificationEvent; status: 'replayed' };
