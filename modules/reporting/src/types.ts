export type ReportingSubject = 'chinese' | 'english' | 'mathematics' | 'science';
export type ReportingAuthorityState =
  'accepted_current' | 'disputed' | 'expired' | 'invalidated' | 'pending';

export interface ReportingActor {
  id: string;
  type: 'guardian' | 'learner';
}

export interface ReportingStateHistoryEntry {
  at: string;
  from: string | null;
  reason: string;
  to: string;
}

export type ReportingJsonValue =
  boolean | null | number | string | ReportingJsonValue[] | { [key: string]: ReportingJsonValue };

export interface ReportingSourceTrace {
  aggregateId: string;
  aggregateType: string;
  authorityState: ReportingAuthorityState;
  history: ReportingStateHistoryEntry[];
  sourceVersions: Record<string, ReportingJsonValue>;
}

export type TodayRouteKind =
  | 'challenge'
  | 'content_confirmation'
  | 'due_review'
  | 'result_review'
  | 'resume_learning'
  | 'variation_practice'
  | 'wrong_item_correction';

export interface TodayRouteCandidate {
  actionTargetId: string;
  createdAt: string;
  current: boolean;
  detail: string;
  dueAt: string | null;
  id: string;
  kind: TodayRouteKind;
  source: ReportingSourceTrace;
  title: string;
}

export interface TodayRouteItem {
  action:
    | 'confirm_content'
    | 'correct_wrong_item'
    | 'resume_learning'
    | 'review_result'
    | 'start_challenge'
    | 'start_review'
    | 'start_variation';
  count: number;
  detail: string;
  estimatedMinutes: number;
  explanation: string;
  id: string;
  isOptional: boolean;
  kind: TodayRouteKind;
  priority: number;
  remainingCount: number;
  sourceTraces: ReportingSourceTrace[];
  targetIds: string[];
  title: string;
}

export interface TodayRouteView {
  generatedAt: string;
  items: TodayRouteItem[];
  learnerProfileId: string;
  noPenaltyMessage: string;
  policyVersion: 'today-route-v1';
}

export type GuardianTodoKind = 'anomaly' | 'authorization' | 'dispute' | 'open_assessment_review';

export interface GuardianTodoCandidate {
  actionTargetId: string;
  createdAt: string;
  current: boolean;
  detail: string;
  id: string;
  kind: GuardianTodoKind;
  source: ReportingSourceTrace;
  title: string;
}

export interface GuardianTodoView extends GuardianTodoCandidate {
  action: 'decide_authorization' | 'inspect_anomaly' | 'review_assessment' | 'review_dispute';
  priority: number;
}

export interface GuardianTodoSummary {
  counts: {
    anomaly: number;
    authorization: number;
    dispute: number;
    openAssessmentReview: number;
    total: number;
  };
  items: GuardianTodoView[];
}

export interface LearningEvidenceReportFact {
  coursePathName: string | null;
  id: string;
  knowledgePointName: string | null;
  learningDate: string;
  occurredAt: string;
  outcome: 'correct' | 'incorrect';
  qualification: 'assisted_success' | 'incorrect' | 'independent_success';
  source: ReportingSourceTrace;
  subject: ReportingSubject;
  themeId: string;
  unitName: string | null;
}

export interface WrongItemChangeReportFact {
  id: string;
  kind: 'mastered' | 'opened' | 'reopened';
  knowledgePointName: string | null;
  occurredAt: string;
  source: ReportingSourceTrace;
  subject: ReportingSubject;
  themeId: string;
  unitName: string | null;
}

export interface ThemeStateReportFact {
  cycle: number;
  knowledgePointName: string | null;
  masteredAt: string | null;
  source: ReportingSourceTrace;
  status: 'active' | 'mastered';
  subject: ReportingSubject;
  themeId: string;
  unitName: string | null;
}

export interface ExcludedReportFact {
  id: string;
  reason: string;
  source: ReportingSourceTrace;
  subject: ReportingSubject | null;
}

export interface ReportingFactSnapshot {
  evidence: LearningEvidenceReportFact[];
  exclusions: ExcludedReportFact[];
  themeStates: ThemeStateReportFact[];
  wrongItemChanges: WrongItemChangeReportFact[];
}

export interface EvidenceCounts {
  assistedSuccesses: number;
  incorrectAttempts: number;
  independentSuccesses: number;
  total: number;
}

export interface LearningReportTrendPoint extends EvidenceCounts {
  date: string;
  masteredThemes: number;
  reopenedThemes: number;
}

export interface LearningReportThemeView {
  evidence: EvidenceCounts;
  knowledgePointName: string | null;
  knowledgePointStatus: 'learning' | 'not_assessed';
  masteryCycle: number;
  masteryStatus: 'active' | 'mastered';
  themeId: string;
  trend: LearningReportTrendPoint[];
  unitName: string | null;
}

export interface LearningReportSubjectView {
  evidence: EvidenceCounts;
  mastery: { activeThemes: number; masteredThemes: number };
  subject: ReportingSubject;
  themes: LearningReportThemeView[];
  trend: LearningReportTrendPoint[];
  wrongItems: { mastered: number; opened: number; reopened: number };
}

export interface LearningReportDrilldown {
  authorityState: ReportingAuthorityState;
  factId: string;
  factKind: 'learning_evidence' | 'theme_state' | 'wrong_item_change';
  sourceAggregateId: string;
  sourceAggregateType: string;
  sourceVersions: ReportingSourceTrace['sourceVersions'];
  stateHistory: ReportingStateHistoryEntry[];
}

export interface LearningReportView {
  conclusions: string[];
  drilldowns: LearningReportDrilldown[];
  excluded: {
    disputed: number;
    expired: number;
    invalidated: number;
    pending: number;
    reasons: Array<{ count: number; reason: string }>;
  };
  generatedAt: string;
  learnerProfileId: string;
  policyVersion: 'learning-report-v1';
  subjects: LearningReportSubjectView[];
  window: { from: string; to: string };
}

export interface GuardianReportView {
  generatedAt: string;
  learnerProfileId: string;
  learningReport: LearningReportView;
  todos: GuardianTodoSummary;
}
