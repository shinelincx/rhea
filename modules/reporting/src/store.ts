import type { GuardianTodoCandidate, ReportingFactSnapshot, TodayRouteCandidate } from './types.js';

export interface ReportingScope {
  familySpaceId: string;
  learningProfileId: string;
}

export interface ReportingStore {
  readGuardianTodoCandidates(scope: ReportingScope, asOf: string): Promise<GuardianTodoCandidate[]>;
  readLearningReportFacts(
    scope: ReportingScope,
    window: { from: string; to: string },
  ): Promise<ReportingFactSnapshot>;
  readTodayRouteCandidates(scope: ReportingScope, asOf: string): Promise<TodayRouteCandidate[]>;
}
