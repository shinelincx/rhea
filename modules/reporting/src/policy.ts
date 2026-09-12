import type {
  EvidenceCounts,
  ExcludedReportFact,
  GuardianTodoCandidate,
  GuardianTodoKind,
  GuardianTodoSummary,
  LearningEvidenceReportFact,
  LearningReportDrilldown,
  LearningReportSubjectView,
  LearningReportThemeView,
  LearningReportTrendPoint,
  LearningReportView,
  ReportingFactSnapshot,
  ReportingSourceTrace,
  ReportingSubject,
  ThemeStateReportFact,
  TodayRouteCandidate,
  TodayRouteItem,
  TodayRouteKind,
  WrongItemChangeReportFact,
} from './types.js';

const ROUTE_PRIORITY: Record<TodayRouteKind, number> = {
  content_confirmation: 1,
  result_review: 2,
  resume_learning: 3,
  due_review: 4,
  wrong_item_correction: 5,
  variation_practice: 6,
  challenge: 7,
};

const ROUTE_PRESENTATION: Record<
  TodayRouteKind,
  Pick<TodayRouteItem, 'action' | 'estimatedMinutes' | 'explanation' | 'isOptional' | 'title'>
> = {
  content_confirmation: {
    action: 'confirm_content',
    estimatedMinutes: 2,
    explanation: '内容确认会阻塞后续批改和学习，先处理最早的一项。',
    isOptional: false,
    title: '先确认识别内容',
  },
  result_review: {
    action: 'review_result',
    estimatedMinutes: 3,
    explanation: '待复核结果尚未成为正式学习事实，先完成确认。',
    isOptional: false,
    title: '复核待确认结果',
  },
  resume_learning: {
    action: 'resume_learning',
    estimatedMinutes: 2,
    explanation: '最近一次异步处理可以继续查看，不需要重新上传。',
    isOptional: true,
    title: '继续最近的拍照学习',
  },
  due_review: {
    action: 'start_review',
    estimatedMinutes: 5,
    explanation: '到期复习优先组成一次约 5 分钟的短复习，最多呈现 5 张。',
    isOptional: true,
    title: '完成今日短复习',
  },
  wrong_item_correction: {
    action: 'correct_wrong_item',
    estimatedMinutes: 4,
    explanation: '先完成一项仍待订正的错题，不要求一次清空队列。',
    isOptional: true,
    title: '订正一个错题主题',
  },
  variation_practice: {
    action: 'start_variation',
    estimatedMinutes: 4,
    explanation: '用一题已检查变式巩固方法，不重复背原题。',
    isOptional: true,
    title: '做一次变式巩固',
  },
  challenge: {
    action: 'start_challenge',
    estimatedMinutes: 5,
    explanation: '挑战是可选成长活动，不影响正式掌握和今日完成。',
    isOptional: true,
    title: '参加一场同伴挑战',
  },
};

const TODO_PRIORITY: Record<GuardianTodoKind, number> = {
  authorization: 1,
  open_assessment_review: 2,
  dispute: 3,
  anomaly: 4,
};

const SUBJECT_ORDER: ReportingSubject[] = ['chinese', 'mathematics', 'english', 'science'];

function timestamp(value: string): number {
  return Date.parse(value);
}

function sourceTime(candidate: TodayRouteCandidate): number {
  return timestamp(candidate.dueAt ?? candidate.createdAt);
}

export function buildTodayRouteItems(candidates: readonly TodayRouteCandidate[]): TodayRouteItem[] {
  const actionable = candidates.filter(({ current }) => current);
  const groups = new Map<TodayRouteKind, TodayRouteCandidate[]>();
  for (const candidate of actionable) {
    const group = groups.get(candidate.kind) ?? [];
    group.push(candidate);
    groups.set(candidate.kind, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => ROUTE_PRIORITY[left] - ROUTE_PRIORITY[right])
    .slice(0, 5)
    .map(([kind, group]) => {
      group.sort(
        (left, right) => sourceTime(left) - sourceTime(right) || left.id.localeCompare(right.id),
      );
      const visibleLimit = kind === 'due_review' ? 5 : 1;
      const visible = group.slice(0, visibleLimit);
      const presentation = ROUTE_PRESENTATION[kind];
      return {
        ...presentation,
        count: visible.length,
        detail: visible[0]?.detail ?? '',
        id: `today:${kind}:${visible[0]?.id ?? 'empty'}`,
        kind,
        priority: ROUTE_PRIORITY[kind],
        remainingCount: Math.max(0, group.length - visible.length),
        sourceTraces: visible.map(({ source }) => source),
        targetIds: visible.map(({ actionTargetId }) => actionTargetId),
      };
    });
}

export function buildGuardianTodos(
  candidates: readonly GuardianTodoCandidate[],
): GuardianTodoSummary {
  const items = candidates
    .filter(({ current }) => current)
    .sort(
      (left, right) =>
        TODO_PRIORITY[left.kind] - TODO_PRIORITY[right.kind] ||
        timestamp(left.createdAt) - timestamp(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 20)
    .map((candidate) => ({
      ...candidate,
      action:
        candidate.kind === 'authorization'
          ? ('decide_authorization' as const)
          : candidate.kind === 'open_assessment_review'
            ? ('review_assessment' as const)
            : candidate.kind === 'dispute'
              ? ('review_dispute' as const)
              : ('inspect_anomaly' as const),
      priority: TODO_PRIORITY[candidate.kind],
    }));
  return {
    counts: {
      anomaly: items.filter(({ kind }) => kind === 'anomaly').length,
      authorization: items.filter(({ kind }) => kind === 'authorization').length,
      dispute: items.filter(({ kind }) => kind === 'dispute').length,
      openAssessmentReview: items.filter(({ kind }) => kind === 'open_assessment_review').length,
      total: items.length,
    },
    items,
  };
}

function emptyEvidenceCounts(): EvidenceCounts {
  return { assistedSuccesses: 0, incorrectAttempts: 0, independentSuccesses: 0, total: 0 };
}

function addEvidence(counts: EvidenceCounts, fact: LearningEvidenceReportFact): void {
  counts.total += 1;
  if (fact.qualification === 'independent_success') counts.independentSuccesses += 1;
  if (fact.qualification === 'assisted_success') counts.assistedSuccesses += 1;
  if (fact.qualification === 'incorrect') counts.incorrectAttempts += 1;
}

function trend(
  evidence: readonly LearningEvidenceReportFact[],
  changes: readonly WrongItemChangeReportFact[],
): LearningReportTrendPoint[] {
  const points = new Map<string, LearningReportTrendPoint>();
  const point = (date: string) => {
    const existing = points.get(date);
    if (existing) return existing;
    const created = { ...emptyEvidenceCounts(), date, masteredThemes: 0, reopenedThemes: 0 };
    points.set(date, created);
    return created;
  };
  for (const fact of evidence) addEvidence(point(fact.learningDate), fact);
  for (const fact of changes) {
    const item = point(fact.occurredAt.slice(0, 10));
    if (fact.kind === 'mastered') item.masteredThemes += 1;
    if (fact.kind === 'reopened') item.reopenedThemes += 1;
  }
  return [...points.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function drilldown(
  factId: string,
  factKind: LearningReportDrilldown['factKind'],
  source: ReportingSourceTrace,
): LearningReportDrilldown {
  return {
    authorityState: source.authorityState,
    factId,
    factKind,
    sourceAggregateId: source.aggregateId,
    sourceAggregateType: source.aggregateType,
    sourceVersions: source.sourceVersions,
    stateHistory: source.history,
  };
}

function exclusionSummary(input: {
  evidence: readonly LearningEvidenceReportFact[];
  exclusions: readonly ExcludedReportFact[];
  themeStates: readonly ThemeStateReportFact[];
  wrongItemChanges: readonly WrongItemChangeReportFact[];
}) {
  const sources = [
    ...input.evidence
      .filter(({ source }) => source.authorityState !== 'accepted_current')
      .map(({ id, source }) => ({ id, reason: `学习证据处于 ${source.authorityState}`, source })),
    ...input.themeStates
      .filter(({ source }) => source.authorityState !== 'accepted_current')
      .map(({ source, themeId }) => ({
        id: themeId,
        reason: `主题状态处于 ${source.authorityState}`,
        source,
      })),
    ...input.wrongItemChanges
      .filter(({ source }) => source.authorityState !== 'accepted_current')
      .map(({ id, source }) => ({
        id,
        reason: `错题变化处于 ${source.authorityState}`,
        source,
      })),
    ...input.exclusions,
  ];
  const count = (state: ReportingSourceTrace['authorityState']) =>
    sources.filter(({ source }) => source.authorityState === state).length;
  const reasons = new Map<string, number>();
  for (const source of sources) reasons.set(source.reason, (reasons.get(source.reason) ?? 0) + 1);
  return {
    disputed: count('disputed'),
    expired: count('expired'),
    invalidated: count('invalidated'),
    pending: count('pending'),
    reasons: [...reasons.entries()]
      .map(([reason, reasonCount]) => ({ count: reasonCount, reason }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
  };
}

function includedInWindow(occurredAt: string, from: string, to: string): boolean {
  const value = timestamp(occurredAt);
  return value >= timestamp(from) && value <= timestamp(to);
}

export function buildLearningReport(input: {
  facts: ReportingFactSnapshot;
  from: string;
  generatedAt: string;
  learningProfileId: string;
  to: string;
}): LearningReportView {
  const windowEvidence = input.facts.evidence.filter(({ occurredAt }) =>
    includedInWindow(occurredAt, input.from, input.to),
  );
  const evidence = windowEvidence.filter(
    ({ source }) => source.authorityState === 'accepted_current',
  );
  const windowChanges = input.facts.wrongItemChanges.filter(({ occurredAt }) =>
    includedInWindow(occurredAt, input.from, input.to),
  );
  const changes = windowChanges.filter(
    ({ occurredAt, source }) =>
      source.authorityState === 'accepted_current' &&
      includedInWindow(occurredAt, input.from, input.to),
  );
  const themeStates = input.facts.themeStates.filter(
    ({ source }) => source.authorityState === 'accepted_current',
  );
  const subjects: LearningReportSubjectView[] = [];
  for (const subject of SUBJECT_ORDER) {
    const subjectEvidence = evidence.filter((fact) => fact.subject === subject);
    const subjectChanges = changes.filter((fact) => fact.subject === subject);
    const subjectStates = themeStates.filter((fact) => fact.subject === subject);
    if (subjectEvidence.length === 0 && subjectChanges.length === 0 && subjectStates.length === 0)
      continue;
    const themeIds = new Set([
      ...subjectEvidence.map(({ themeId }) => themeId),
      ...subjectChanges.map(({ themeId }) => themeId),
      ...subjectStates.map(({ themeId }) => themeId),
    ]);
    const themes: LearningReportThemeView[] = [...themeIds].sort().map((themeId) => {
      const themeEvidence = subjectEvidence.filter((fact) => fact.themeId === themeId);
      const themeChanges = subjectChanges.filter((fact) => fact.themeId === themeId);
      const state = subjectStates.find((fact) => fact.themeId === themeId);
      const counts = emptyEvidenceCounts();
      for (const fact of themeEvidence) addEvidence(counts, fact);
      return {
        evidence: counts,
        knowledgePointName:
          state?.knowledgePointName ?? themeEvidence[0]?.knowledgePointName ?? null,
        knowledgePointStatus: counts.total > 0 ? 'learning' : 'not_assessed',
        masteryCycle: state?.cycle ?? 1,
        masteryStatus: state?.status ?? 'active',
        themeId,
        trend: trend(themeEvidence, themeChanges),
        unitName: state?.unitName ?? themeEvidence[0]?.unitName ?? null,
      };
    });
    const counts = emptyEvidenceCounts();
    for (const fact of subjectEvidence) addEvidence(counts, fact);
    subjects.push({
      evidence: counts,
      mastery: {
        activeThemes: subjectStates.filter(({ status }) => status === 'active').length,
        masteredThemes: subjectStates.filter(({ status }) => status === 'mastered').length,
      },
      subject,
      themes,
      trend: trend(subjectEvidence, subjectChanges),
      wrongItems: {
        mastered: subjectChanges.filter(({ kind }) => kind === 'mastered').length,
        opened: subjectChanges.filter(({ kind }) => kind === 'opened').length,
        reopened: subjectChanges.filter(({ kind }) => kind === 'reopened').length,
      },
    });
  }
  const drilldowns = [
    ...evidence.map(({ id, source }) => drilldown(id, 'learning_evidence', source)),
    ...changes.map(({ id, source }) => drilldown(id, 'wrong_item_change', source)),
    ...themeStates.map(({ source, themeId }) => drilldown(themeId, 'theme_state', source)),
  ];
  return {
    conclusions: subjects.map(
      ({ evidence: counts, mastery, subject }) =>
        `${subject}：${counts.independentSuccesses} 条独立证据，${mastery.masteredThemes} 个错题主题已掌握。`,
    ),
    drilldowns,
    excluded: exclusionSummary({
      evidence: windowEvidence,
      exclusions: input.facts.exclusions,
      themeStates: input.facts.themeStates,
      wrongItemChanges: windowChanges,
    }),
    generatedAt: input.generatedAt,
    learnerProfileId: input.learningProfileId,
    policyVersion: 'learning-report-v1',
    subjects,
    window: { from: input.from, to: input.to },
  };
}
