import { createReportingGateway, ReportingGatewayError } from '../src/reporting/reporting-gateway';

const report = {
  generatedAt: '2026-09-15T00:00:00.000Z',
  learnerProfileId: 'profile-1',
  learningReport: {
    conclusions: ['mathematics：1 条独立证据，0 个错题主题已掌握。'],
    drilldowns: [
      {
        authorityState: 'accepted_current',
        factId: 'evidence-1',
        factKind: 'learning_evidence',
        sourceAggregateId: 'wrong-item-1',
        sourceAggregateType: 'wrong_item',
        sourceVersions: { assessmentRevision: 2 },
        stateHistory: [],
      },
    ],
    excluded: { disputed: 0, expired: 0, invalidated: 0, pending: 1, reasons: [] },
    policyVersion: 'learning-report-v1',
    subjects: [
      {
        evidence: {
          assistedSuccesses: 0,
          incorrectAttempts: 0,
          independentSuccesses: 1,
          total: 1,
        },
        mastery: { activeThemes: 1, masteredThemes: 0 },
        subject: 'mathematics',
        themes: [
          {
            evidence: {
              assistedSuccesses: 0,
              incorrectAttempts: 0,
              independentSuccesses: 1,
              total: 1,
            },
            knowledgePointName: '两位数乘法',
            knowledgePointStatus: 'learning',
            masteryCycle: 1,
            masteryStatus: 'active',
            themeId: 'theme-1',
            trend: [
              {
                assistedSuccesses: 0,
                date: '2026-09-14',
                incorrectAttempts: 0,
                independentSuccesses: 1,
                masteredThemes: 0,
                reopenedThemes: 0,
                total: 1,
              },
            ],
            unitName: '乘法单元',
          },
        ],
        trend: [],
        wrongItems: { mastered: 0, opened: 1, reopened: 0 },
      },
    ],
    window: { from: '2026-08-19T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
  },
  todos: {
    counts: { anomaly: 0, authorization: 1, dispute: 0, openAssessmentReview: 0, total: 1 },
    items: [
      {
        action: 'decide_authorization',
        detail: '请选择是否允许 AI 处理。',
        id: 'authorization-ai',
        kind: 'authorization',
        title: '决定 AI 处理授权',
      },
    ],
  },
};

describe('reporting gateway', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the guardian session and parses evidence, trends, exclusions, and traces', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: report }), { status: 200 }));

    await expect(
      createReportingGateway('https://api.example.test/').getGuardianReport({
        accessToken: 'guardian-token',
        familySpaceId: 'family 1',
        learningProfileId: 'profile/1',
      }),
    ).resolves.toMatchObject({
      learningReport: {
        excluded: { pending: 1 },
        subjects: [{ themes: [{ trend: [{ independentSuccesses: 1 }] }] }],
      },
      todos: { counts: { total: 1 } },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/family-spaces/family%201/learning-profiles/profile%2F1/guardian-report',
      {
        headers: { Accept: 'application/json', Authorization: 'Bearer guardian-token' },
      },
    );
  });

  it('rejects malformed trend counts rather than presenting untrusted conclusions', async () => {
    const malformed = structuredClone(report);
    malformed.learningReport.subjects[0]!.themes[0]!.trend[0]!.independentSuccesses = -1;
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: malformed }), { status: 200 }));

    await expect(
      createReportingGateway('https://api.example.test').getGuardianReport({
        accessToken: 'guardian-token',
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
      }),
    ).rejects.toBeInstanceOf(ReportingGatewayError);
  });
});
