import { fireEvent, render, waitFor } from '@testing-library/react-native';

import type {
  FamilyEntryGateway,
  MobileConsent,
  MobileLearningProfile,
} from '../src/family-entry/gateway';
import { GuardianConsentScreen } from '../src/guardian-consent/GuardianConsentScreen';
import type { MobileGuardianReport, ReportingGateway } from '../src/reporting/reporting-gateway';

const initialConsents: MobileConsent[] = [
  {
    dataScope: ['学习照片与最小裁剪'],
    familySpaceId: 'family-1',
    kind: 'photo_processing',
    purpose: '识别学习资料与作答',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
  {
    dataScope: ['已确认学习内容'],
    familySpaceId: 'family-1',
    kind: 'ai_processing',
    purpose: '生成适龄学习内容',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
  {
    dataScope: ['年级与本场进度'],
    familySpaceId: 'family-1',
    kind: 'peer_challenge',
    purpose: '参与同伴挑战',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
  {
    dataScope: ['设备推送标识'],
    familySpaceId: 'family-1',
    kind: 'notifications',
    purpose: '发送通用提醒',
    revision: 0,
    statementVersion: 'family-consent-v1',
    status: 'not_decided',
    updatedAt: null,
  },
];

const profiles: MobileLearningProfile[] = [
  { displayName: '小禾', familySpaceId: 'family-1', grade: 4, id: 'profile-1' },
];

const emptyReport: MobileGuardianReport = {
  generatedAt: '2026-09-15T00:00:00.000Z',
  learnerProfileId: 'profile-1',
  learningReport: {
    conclusions: [],
    drilldowns: [],
    excluded: { disputed: 0, expired: 0, invalidated: 0, pending: 0, reasons: [] },
    policyVersion: 'learning-report-v1',
    subjects: [],
    window: { from: '2026-08-19T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
  },
  todos: {
    counts: { anomaly: 0, authorization: 0, dispute: 0, openAssessmentReview: 0, total: 0 },
    items: [],
  },
};

function reportingGateway(report: MobileGuardianReport = emptyReport): ReportingGateway {
  return { getGuardianReport: jest.fn().mockResolvedValue(report) };
}

describe('guardian consent interface', () => {
  it('shows separate purposes and immediately reflects grant and withdrawal', async () => {
    const granted = {
      ...initialConsents[0]!,
      revision: 1,
      status: 'granted' as const,
      updatedAt: '2026-09-09T08:00:00.000Z',
    };
    const withdrawn = { ...granted, revision: 2, status: 'withdrawn' as const };
    const changeConsent = jest.fn().mockResolvedValueOnce(granted).mockResolvedValueOnce(withdrawn);
    const gateway: FamilyEntryGateway = {
      changeConsent,
      enterProfile: async () => {
        throw new Error('not used');
      },
      listProfiles: async () => [],
      logout: async () => undefined,
      openGuardianSettings: async () => ({
        accessToken: 'guardian-token',
        consents: initialConsents,
      }),
      setupFamily: async () => {
        throw new Error('not used');
      },
    };
    const view = await render(
      <GuardianConsentScreen
        familySpaceId="family-1"
        gateway={gateway}
        learningProfiles={profiles}
        onClose={jest.fn()}
        reportingGateway={reportingGateway()}
      />,
    );

    await waitFor(() => expect(view.getByText('照片与文件处理')).toBeTruthy());
    expect(view.getByText('AI 处理')).toBeTruthy();
    expect(view.getByText('同伴挑战')).toBeTruthy();
    expect(view.getByText('通知')).toBeTruthy();
    expect(view.getAllByText('尚未选择')).toHaveLength(4);

    await fireEvent.press(view.getByRole('button', { name: '照片与文件处理：重新验证并同意' }));
    await waitFor(() => expect(view.getByText('照片与文件处理已开启。')).toBeTruthy());
    expect(changeConsent).toHaveBeenLastCalledWith({
      accessToken: 'guardian-token',
      familySpaceId: 'family-1',
      granted: true,
      kind: 'photo_processing',
    });

    await fireEvent.press(view.getByRole('button', { name: '照片与文件处理：重新验证并撤回' }));
    await waitFor(() =>
      expect(view.getByText('照片与文件处理已关闭，不会再创建新的相关处理。')).toBeTruthy(),
    );
    expect(view.getByText(/撤回只会停止新的处理或会话，不代表历史资料已删除/)).toBeTruthy();
  });

  it('shows guardian todos, evidence trends, formal exclusions, and traceable sources', async () => {
    const gateway: FamilyEntryGateway = {
      changeConsent: async () => {
        throw new Error('not used');
      },
      enterProfile: async () => {
        throw new Error('not used');
      },
      listProfiles: async () => [],
      logout: async () => undefined,
      openGuardianSettings: async () => ({
        accessToken: 'guardian-token',
        consents: initialConsents,
      }),
      setupFamily: async () => {
        throw new Error('not used');
      },
    };
    const report: MobileGuardianReport = {
      ...emptyReport,
      learningReport: {
        ...emptyReport.learningReport,
        conclusions: ['mathematics：2 条独立证据，1 个错题主题已掌握。'],
        drilldowns: [
          {
            authorityState: 'accepted_current',
            factId: 'evidence-1',
            factKind: 'learning_evidence',
            sourceAggregateId: 'wrong-item-1',
            sourceAggregateType: 'wrong_item',
            sourceVersions: { assessmentRevision: 2, wrongItemVersion: 3 },
            stateHistory: [
              {
                at: '2026-09-14T08:00:00.000Z',
                from: 'active',
                reason: '复做通过',
                to: 'mastered',
              },
            ],
          },
        ],
        excluded: {
          disputed: 1,
          expired: 0,
          invalidated: 0,
          pending: 2,
          reasons: [{ count: 2, reason: '开放题建议尚未接受' }],
        },
        subjects: [
          {
            evidence: {
              assistedSuccesses: 1,
              incorrectAttempts: 1,
              independentSuccesses: 2,
              total: 4,
            },
            mastery: { activeThemes: 1, masteredThemes: 1 },
            subject: 'mathematics',
            themes: [
              {
                evidence: {
                  assistedSuccesses: 1,
                  incorrectAttempts: 1,
                  independentSuccesses: 2,
                  total: 4,
                },
                knowledgePointName: '两位数乘法',
                knowledgePointStatus: 'learning',
                masteryCycle: 2,
                masteryStatus: 'mastered',
                themeId: 'theme-1',
                trend: [
                  {
                    assistedSuccesses: 0,
                    date: '2026-09-14',
                    incorrectAttempts: 1,
                    independentSuccesses: 2,
                    masteredThemes: 1,
                    reopenedThemes: 0,
                    total: 3,
                  },
                ],
                unitName: '乘法单元',
              },
            ],
            trend: [
              {
                assistedSuccesses: 0,
                date: '2026-09-14',
                incorrectAttempts: 1,
                independentSuccesses: 2,
                masteredThemes: 1,
                reopenedThemes: 0,
                total: 3,
              },
            ],
            wrongItems: { mastered: 1, opened: 2, reopened: 1 },
          },
        ],
      },
      todos: {
        counts: { anomaly: 0, authorization: 1, dispute: 0, openAssessmentReview: 1, total: 2 },
        items: [
          {
            action: 'decide_authorization',
            detail: '请选择是否允许 AI 处理。',
            id: 'authorization-ai',
            kind: 'authorization',
            title: '决定 AI 处理授权',
          },
          {
            action: 'review_assessment',
            detail: '开放题建议尚未接受。',
            id: 'assessment-1',
            kind: 'open_assessment_review',
            title: '复核开放题结果',
          },
        ],
      },
    };
    const reports = reportingGateway(report);
    const view = await render(
      <GuardianConsentScreen
        familySpaceId="family-1"
        gateway={gateway}
        learningProfiles={profiles}
        onClose={jest.fn()}
        reportingGateway={reports}
      />,
    );

    await waitFor(() => expect(view.getByText('待确认事项 · 2')).toBeTruthy());
    expect(reports.getGuardianReport).toHaveBeenCalledWith({
      accessToken: 'guardian-token',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
    });
    expect(view.getByText('决定 AI 处理授权')).toBeTruthy();
    expect(view.getByText('数学 · 最近 28 天')).toBeTruthy();
    expect(view.getByText(/独立完成 2 次/)).toBeTruthy();
    expect(view.getByText(/错题变化：新增 2 · 掌握 1 · 重开 1/)).toBeTruthy();
    expect(view.getByText(/两位数乘法/)).toBeTruthy();
    expect(view.getByText(/09-14.*独立 2.*掌握主题 1/)).toBeTruthy();
    expect(view.getByText('3 条结果未计入正式学习进展')).toBeTruthy();
    expect(view.getByText(/待确认 2 · 争议中 1/)).toBeTruthy();

    await fireEvent.press(view.getByRole('button', { name: '查看来源与状态历史' }));
    expect(view.getByText(/来源 wrong_item · wrong-item-1/)).toBeTruthy();
    expect(view.getByText(/版本.*assessmentRevision.*2/)).toBeTruthy();
    expect(view.getByText(/active → mastered · 复做通过/)).toBeTruthy();
  });
});
