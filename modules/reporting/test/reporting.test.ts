import { describe, expect, it } from 'vitest';

import {
  MemoryReportingStore,
  ReportingError,
  ReportingService,
  type LearningEvidenceReportFact,
  type ReportingSourceTrace,
  type TodayRouteCandidate,
} from '../src/index.js';

const scope = { familySpaceId: 'family-1', learningProfileId: 'profile-1' };
const learner = { id: 'profile-1', type: 'learner' as const };
const guardian = { id: 'guardian-1', type: 'guardian' as const };

function trace(
  id: string,
  authorityState: ReportingSourceTrace['authorityState'] = 'accepted_current',
): ReportingSourceTrace {
  return {
    aggregateId: id,
    aggregateType: 'assessment',
    authorityState,
    history: [
      {
        at: '2026-09-10T00:00:00.000Z',
        from: null,
        reason: 'accepted by authorized reviewer',
        to: authorityState,
      },
    ],
    sourceVersions: {
      assessmentVersionId: `version-${id}`,
      basisSourceVersionId: 'basis-1',
      basisValidityEpoch: 1,
    },
  };
}

function routeCandidate(
  id: string,
  kind: TodayRouteCandidate['kind'],
  overrides: Partial<TodayRouteCandidate> = {},
): TodayRouteCandidate {
  return {
    actionTargetId: id,
    createdAt: '2026-09-14T00:00:00.000Z',
    current: true,
    detail: `处理 ${id}`,
    dueAt: null,
    id,
    kind,
    source: trace(id),
    title: id,
    ...overrides,
  };
}

function evidence(
  id: string,
  authorityState: ReportingSourceTrace['authorityState'],
  overrides: Partial<LearningEvidenceReportFact> = {},
): LearningEvidenceReportFact {
  return {
    id,
    knowledgePointName: '两位数加法',
    learningDate: '2026-09-14',
    occurredAt: '2026-09-14T01:00:00.000Z',
    outcome: 'correct',
    qualification: 'independent_success',
    source: trace(id, authorityState),
    subject: 'mathematics',
    themeId: 'math:addition',
    unitName: '加法单元',
    coursePathName: '四年级数学',
    ...overrides,
  };
}

describe('ReportingService', () => {
  it('builds a short, explainable route in the approved priority order', async () => {
    const dueReviews = Array.from({ length: 7 }, (_, index) =>
      routeCandidate(`review-${index}`, 'due_review', {
        dueAt: `2026-09-${String(8 + index).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const store = new MemoryReportingStore({
      routeCandidates: [
        routeCandidate('challenge', 'challenge'),
        routeCandidate('variation', 'variation_practice'),
        routeCandidate('correction', 'wrong_item_correction'),
        ...dueReviews,
        routeCandidate('resume', 'resume_learning'),
        routeCandidate('result', 'result_review'),
        routeCandidate('content', 'content_confirmation'),
        routeCandidate('stale', 'content_confirmation', { current: false }),
      ],
    });
    const service = new ReportingService({
      clock: { now: new Date('2026-09-15T00:00:00.000Z') },
      store,
    });

    const route = await service.getTodayRoute({ actor: learner, ...scope });

    expect(route.items.map(({ kind }) => kind)).toEqual([
      'content_confirmation',
      'result_review',
      'resume_learning',
      'due_review',
      'wrong_item_correction',
    ]);
    expect(route.items).toHaveLength(5);
    expect(route.items[3]).toMatchObject({
      count: 5,
      explanation: '到期复习优先组成一次约 5 分钟的短复习，最多呈现 5 张。',
      remainingCount: 2,
      targetIds: ['review-0', 'review-1', 'review-2', 'review-3', 'review-4'],
    });
    expect(route.noPenaltyMessage).toContain('跳过或稍后完成不会扣分');
  });

  it('keeps guardian work together and excludes unaccepted facts from formal progress', async () => {
    const store = new MemoryReportingStore({
      evidence: [
        evidence('accepted-independent', 'accepted_current'),
        evidence('accepted-assisted', 'accepted_current', {
          qualification: 'assisted_success',
        }),
        evidence('pending', 'pending'),
        evidence('disputed', 'disputed'),
        evidence('expired', 'expired'),
      ],
      exclusions: [
        {
          id: 'suggestion-1',
          reason: '开放题建议尚未接受',
          source: trace('suggestion-1', 'pending'),
          subject: 'chinese',
        },
      ],
      guardianTodos: [
        {
          actionTargetId: 'consent-ai',
          createdAt: '2026-09-10T00:00:00.000Z',
          current: true,
          detail: '尚未决定 AI 处理授权',
          id: 'consent-ai',
          kind: 'authorization',
          source: trace('consent-ai', 'pending'),
          title: '确认 AI 处理授权',
        },
        {
          actionTargetId: 'suggestion-1',
          createdAt: '2026-09-11T00:00:00.000Z',
          current: true,
          detail: '查看开放题建议',
          id: 'suggestion-1',
          kind: 'open_assessment_review',
          source: trace('suggestion-1', 'pending'),
          title: '复核开放题建议',
        },
        {
          actionTargetId: 'resolved',
          createdAt: '2026-09-09T00:00:00.000Z',
          current: false,
          detail: '已处理',
          id: 'resolved',
          kind: 'anomaly',
          source: trace('resolved'),
          title: '旧异常',
        },
      ],
      themeStates: [
        {
          cycle: 1,
          knowledgePointName: '两位数加法',
          masteredAt: '2026-09-14T01:00:00.000Z',
          source: trace('math:addition'),
          status: 'mastered',
          subject: 'mathematics',
          themeId: 'math:addition',
          unitName: '加法单元',
        },
        {
          cycle: 1,
          knowledgePointName: '待确认主题',
          masteredAt: null,
          source: trace('math:pending', 'pending'),
          status: 'active',
          subject: 'mathematics',
          themeId: 'math:pending',
          unitName: '待确认单元',
        },
        {
          cycle: 2,
          knowledgePointName: '争议主题',
          masteredAt: '2026-09-13T01:00:00.000Z',
          source: trace('math:disputed', 'disputed'),
          status: 'mastered',
          subject: 'mathematics',
          themeId: 'math:disputed',
          unitName: '争议单元',
        },
      ],
      wrongItemChanges: [
        {
          id: 'change-opened',
          kind: 'opened',
          knowledgePointName: '两位数加法',
          occurredAt: '2026-09-10T01:00:00.000Z',
          source: trace('change-opened'),
          subject: 'mathematics',
          themeId: 'math:addition',
          unitName: '加法单元',
        },
        {
          id: 'change-mastered',
          kind: 'mastered',
          knowledgePointName: '两位数加法',
          occurredAt: '2026-09-14T01:00:00.000Z',
          source: trace('change-mastered'),
          subject: 'mathematics',
          themeId: 'math:addition',
          unitName: '加法单元',
        },
        {
          id: 'change-expired',
          kind: 'mastered',
          knowledgePointName: '过期主题',
          occurredAt: '2026-09-13T01:00:00.000Z',
          source: trace('change-expired', 'expired'),
          subject: 'mathematics',
          themeId: 'math:expired',
          unitName: '过期单元',
        },
        {
          id: 'change-invalidated',
          kind: 'reopened',
          knowledgePointName: '失效主题',
          occurredAt: '2026-09-12T01:00:00.000Z',
          source: trace('change-invalidated', 'invalidated'),
          subject: 'mathematics',
          themeId: 'math:invalidated',
          unitName: '失效单元',
        },
      ],
    });
    const service = new ReportingService({
      clock: { now: new Date('2026-09-15T00:00:00.000Z') },
      store,
    });

    await expect(service.getGuardianReport({ actor: learner, ...scope })).rejects.toMatchObject<
      Partial<ReportingError>
    >({ code: 'GUARDIAN_REQUIRED' });

    const dashboard = await service.getGuardianReport({ actor: guardian, ...scope });
    expect(dashboard.todos.items.map(({ kind }) => kind)).toEqual([
      'authorization',
      'open_assessment_review',
    ]);
    expect(dashboard.todos.counts).toMatchObject({ authorization: 1, openAssessmentReview: 1 });
    expect(dashboard.learningReport.subjects).toMatchObject([
      {
        evidence: { assistedSuccesses: 1, independentSuccesses: 1, total: 2 },
        mastery: { activeThemes: 0, masteredThemes: 1 },
        subject: 'mathematics',
        themes: [
          {
            evidence: { total: 2 },
            knowledgePointStatus: 'learning',
            masteryStatus: 'mastered',
            themeId: 'math:addition',
          },
        ],
        wrongItems: { mastered: 1, opened: 1 },
      },
    ]);
    expect(dashboard.learningReport.excluded).toMatchObject({
      disputed: 2,
      expired: 2,
      invalidated: 1,
      pending: 3,
    });
    expect(dashboard.learningReport.drilldowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factId: 'accepted-independent',
          sourceVersions: expect.objectContaining({
            assessmentVersionId: 'version-accepted-independent',
          }),
          stateHistory: expect.any(Array),
        }),
      ]),
    );
  });
});
