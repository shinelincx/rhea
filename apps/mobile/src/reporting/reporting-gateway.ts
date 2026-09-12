export type MobileSubject = 'chinese' | 'english' | 'mathematics' | 'science';

export interface MobileGuardianTodo {
  action: 'decide_authorization' | 'inspect_anomaly' | 'review_assessment' | 'review_dispute';
  detail: string;
  id: string;
  kind: 'anomaly' | 'authorization' | 'dispute' | 'open_assessment_review';
  title: string;
}

export interface MobileEvidenceCounts {
  assistedSuccesses: number;
  incorrectAttempts: number;
  independentSuccesses: number;
  total: number;
}

export interface MobileLearningTrendPoint extends MobileEvidenceCounts {
  date: string;
  masteredThemes: number;
  reopenedThemes: number;
}

export interface MobileReportTheme {
  evidence: MobileEvidenceCounts;
  knowledgePointName: string | null;
  knowledgePointStatus: 'learning' | 'not_assessed';
  masteryCycle: number;
  masteryStatus: 'active' | 'mastered';
  themeId: string;
  trend: MobileLearningTrendPoint[];
  unitName: string | null;
}

export interface MobileReportSubject {
  evidence: MobileEvidenceCounts;
  mastery: { activeThemes: number; masteredThemes: number };
  subject: MobileSubject;
  themes: MobileReportTheme[];
  trend: MobileLearningTrendPoint[];
  wrongItems: { mastered: number; opened: number; reopened: number };
}

export interface MobileReportDrilldown {
  authorityState: 'accepted_current' | 'disputed' | 'expired' | 'invalidated' | 'pending';
  factId: string;
  factKind: 'learning_evidence' | 'theme_state' | 'wrong_item_change';
  sourceAggregateId: string;
  sourceAggregateType: string;
  sourceVersions: Record<string, unknown>;
  stateHistory: Array<{ at: string; from: string | null; reason: string; to: string }>;
}

export interface MobileGuardianReport {
  generatedAt: string;
  learnerProfileId: string;
  learningReport: {
    conclusions: string[];
    drilldowns: MobileReportDrilldown[];
    excluded: {
      disputed: number;
      expired: number;
      invalidated: number;
      pending: number;
      reasons: Array<{ count: number; reason: string }>;
    };
    policyVersion: 'learning-report-v1';
    subjects: MobileReportSubject[];
    window: { from: string; to: string };
  };
  todos: {
    counts: {
      anomaly: number;
      authorization: number;
      dispute: number;
      openAssessmentReview: number;
      total: number;
    };
    items: MobileGuardianTodo[];
  };
}

export interface ReportingGateway {
  getGuardianReport(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<MobileGuardianReport>;
}

export class ReportingGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportingGatewayError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportingGatewayError(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ReportingGatewayError(`${label}格式无效`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReportingGatewayError(`${label}格式无效`);
  }
  return value as number;
}

function list<Value>(value: unknown, label: string, parse: (item: unknown) => Value): Value[] {
  if (!Array.isArray(value)) throw new ReportingGatewayError(`${label}格式无效`);
  return value.map(parse);
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ReportingGatewayError(`${label}格式无效`);
  }
  return value as Values[number];
}

function evidenceCounts(value: unknown): MobileEvidenceCounts {
  const item = record(value, '学习证据计数');
  return {
    assistedSuccesses: count(item.assistedSuccesses, '辅助成功数'),
    incorrectAttempts: count(item.incorrectAttempts, '错误次数'),
    independentSuccesses: count(item.independentSuccesses, '独立成功数'),
    total: count(item.total, '证据总数'),
  };
}

function trendPoint(value: unknown): MobileLearningTrendPoint {
  const item = record(value, '学习趋势');
  return {
    ...evidenceCounts(item),
    date: text(item.date, '趋势日期'),
    masteredThemes: count(item.masteredThemes, '掌握主题数'),
    reopenedThemes: count(item.reopenedThemes, '重开主题数'),
  };
}

function reportTheme(value: unknown): MobileReportTheme {
  const item = record(value, '错题主题');
  return {
    evidence: evidenceCounts(item.evidence),
    knowledgePointName: nullableText(item.knowledgePointName, '知识点'),
    knowledgePointStatus: oneOf(
      item.knowledgePointStatus,
      ['learning', 'not_assessed'] as const,
      '知识点状态',
    ),
    masteryCycle: count(item.masteryCycle, '掌握周期'),
    masteryStatus: oneOf(item.masteryStatus, ['active', 'mastered'] as const, '掌握状态'),
    themeId: text(item.themeId, '主题标识'),
    trend: list(item.trend, '主题趋势', trendPoint),
    unitName: nullableText(item.unitName, '学习单元'),
  };
}

function reportSubject(value: unknown): MobileReportSubject {
  const item = record(value, '学科报告');
  const mastery = record(item.mastery, '掌握摘要');
  const wrongItems = record(item.wrongItems, '错题变化');
  return {
    evidence: evidenceCounts(item.evidence),
    mastery: {
      activeThemes: count(mastery.activeThemes, '学习中主题数'),
      masteredThemes: count(mastery.masteredThemes, '已掌握主题数'),
    },
    subject: oneOf(item.subject, ['chinese', 'mathematics', 'english', 'science'] as const, '学科'),
    themes: list(item.themes, '错题主题', reportTheme),
    trend: list(item.trend, '学科趋势', trendPoint),
    wrongItems: {
      mastered: count(wrongItems.mastered, '掌握变化数'),
      opened: count(wrongItems.opened, '新增错题数'),
      reopened: count(wrongItems.reopened, '重开错题数'),
    },
  };
}

function drilldown(value: unknown): MobileReportDrilldown {
  const item = record(value, '来源详情');
  const sourceVersions = record(item.sourceVersions, '来源版本');
  return {
    authorityState: oneOf(
      item.authorityState,
      ['accepted_current', 'pending', 'disputed', 'expired', 'invalidated'] as const,
      '来源状态',
    ),
    factId: text(item.factId, '事实标识'),
    factKind: oneOf(
      item.factKind,
      ['learning_evidence', 'theme_state', 'wrong_item_change'] as const,
      '事实类型',
    ),
    sourceAggregateId: text(item.sourceAggregateId, '来源标识'),
    sourceAggregateType: text(item.sourceAggregateType, '来源类型'),
    sourceVersions,
    stateHistory: list(item.stateHistory, '状态历史', (entry) => {
      const history = record(entry, '状态历史项');
      return {
        at: text(history.at, '状态时间'),
        from: nullableText(history.from, '原状态'),
        reason: text(history.reason, '状态原因'),
        to: text(history.to, '新状态'),
      };
    }),
  };
}

function guardianReport(value: unknown): MobileGuardianReport {
  const root = record(value, '监护报告');
  const learningReport = record(root.learningReport, '学习报告');
  const excluded = record(learningReport.excluded, '排除摘要');
  const todos = record(root.todos, '监护待办');
  const todoCounts = record(todos.counts, '待办计数');
  const window = record(learningReport.window, '报告窗口');
  return {
    generatedAt: text(root.generatedAt, '生成时间'),
    learnerProfileId: text(root.learnerProfileId, '学习档案'),
    learningReport: {
      conclusions: list(learningReport.conclusions, '报告结论', (item) => text(item, '报告结论')),
      drilldowns: list(learningReport.drilldowns, '来源详情', drilldown),
      excluded: {
        disputed: count(excluded.disputed, '争议排除数'),
        expired: count(excluded.expired, '过期排除数'),
        invalidated: count(excluded.invalidated, '失效排除数'),
        pending: count(excluded.pending, '待确认排除数'),
        reasons: list(excluded.reasons, '排除原因', (reason) => {
          const item = record(reason, '排除原因');
          return { count: count(item.count, '排除数量'), reason: text(item.reason, '排除原因') };
        }),
      },
      policyVersion: oneOf(
        learningReport.policyVersion,
        ['learning-report-v1'] as const,
        '报告版本',
      ),
      subjects: list(learningReport.subjects, '学科报告', reportSubject),
      window: { from: text(window.from, '开始时间'), to: text(window.to, '结束时间') },
    },
    todos: {
      counts: {
        anomaly: count(todoCounts.anomaly, '异常数'),
        authorization: count(todoCounts.authorization, '授权待办数'),
        dispute: count(todoCounts.dispute, '质疑数'),
        openAssessmentReview: count(todoCounts.openAssessmentReview, '开放题复核数'),
        total: count(todoCounts.total, '待办总数'),
      },
      items: list(todos.items, '监护待办', (todo) => {
        const item = record(todo, '监护待办项');
        return {
          action: oneOf(
            item.action,
            [
              'decide_authorization',
              'inspect_anomaly',
              'review_assessment',
              'review_dispute',
            ] as const,
            '待办操作',
          ),
          detail: text(item.detail, '待办说明'),
          id: text(item.id, '待办标识'),
          kind: oneOf(
            item.kind,
            ['authorization', 'open_assessment_review', 'dispute', 'anomaly'] as const,
            '待办类型',
          ),
          title: text(item.title, '待办标题'),
        };
      }),
    },
  };
}

export function createReportingGateway(baseUrl: string): ReportingGateway {
  const root = baseUrl.replace(/\/$/, '');
  return {
    async getGuardianReport(input) {
      const response = await fetch(
        `${root}/v1/family-spaces/${encodeURIComponent(
          input.familySpaceId,
        )}/learning-profiles/${encodeURIComponent(input.learningProfileId)}/guardian-report`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${input.accessToken}`,
          },
        },
      );
      if (!response.ok) {
        throw new ReportingGatewayError(`学习报告请求失败（${response.status}）`);
      }
      const envelope = record(await response.json(), '学习报告响应');
      return guardianReport(envelope.data);
    },
  };
}
