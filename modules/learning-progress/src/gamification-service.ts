import { LearningProgressError } from './error.js';
import type { GamificationStore } from './gamification-store.js';
import type {
  GamificationAuthorityState,
  GamificationEvent,
  GamificationEventKind,
  GamificationScope,
  GrowthBadgeView,
  GrowthComponentView,
  GrowthView,
  RecordGamificationEventResult,
} from './gamification-types.js';

const AUTHORITY_STATES = new Set<GamificationAuthorityState>([
  'accepted_current',
  'disputed',
  'expired',
  'invalidated',
  'pending',
  'shadow',
]);
const TERMINAL_AUTHORITY_STATES = new Set<GamificationAuthorityState>([
  'disputed',
  'expired',
  'invalidated',
]);
const EVENT_KINDS = new Set<GamificationEventKind>([
  'learning_evidence_assisted',
  'learning_evidence_independent',
  'review_completed',
  'safe_challenge_completed',
]);
const XP_BY_KIND: Record<GamificationEventKind, number> = {
  learning_evidence_assisted: 12,
  learning_evidence_independent: 20,
  review_completed: 15,
  safe_challenge_completed: 10,
};

function required(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new LearningProgressError(
      'INPUT_INVALID',
      `${label}不能为空且不能超过 ${maximum} 个字符`,
    );
  }
  return normalized;
}

function checkedIso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new LearningProgressError('INPUT_INVALID', `${label}必须是有效时间`);
  }
  return new Date(value).toISOString();
}

function checkedDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new LearningProgressError('INPUT_INVALID', '学习日期必须使用 YYYY-MM-DD');
  }
  return value;
}

function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(value);
}

function consecutiveRun(dates: string[], today: string): { bestDays: number; currentDays: number } {
  const days = [...new Set(dates)].sort();
  let bestDays = 0;
  let run = 0;
  let previous: number | null = null;
  for (const value of days) {
    const day = Date.parse(`${value}T00:00:00Z`) / 86_400_000;
    run = previous !== null && day - previous === 1 ? run + 1 : 1;
    bestDays = Math.max(bestDays, run);
    previous = day;
  }
  const latest = days.at(-1);
  const latestDay = latest ? Date.parse(`${latest}T00:00:00Z`) : Number.NaN;
  const todayDay = Date.parse(`${today}T00:00:00Z`);
  let currentDays = 0;
  if (days.length > 0 && todayDay - latestDay <= 86_400_000) {
    currentDays = 1;
    for (let index = days.length - 1; index > 0; index -= 1) {
      const current = Date.parse(`${days[index]}T00:00:00Z`);
      const before = Date.parse(`${days[index - 1]}T00:00:00Z`);
      if (current - before !== 86_400_000) break;
      currentDays += 1;
    }
  }
  return { bestDays, currentDays };
}

function component(
  name: GrowthComponentView['name'],
  weight: GrowthComponentView['weight'],
  earnedUnits: number,
  explanation: string,
): GrowthComponentView {
  return {
    contribution: Math.min(weight, Math.round((Math.min(100, earnedUnits) / 100) * weight)),
    earnedUnits: Math.min(100, earnedUnits),
    explanation,
    maximumContribution: weight,
    name,
    weight,
  };
}

export interface GamificationServiceDependencies {
  clock?: { readonly now: Date };
  store: GamificationStore;
}

export class GamificationService {
  readonly #clock: { readonly now: Date };
  readonly #store: GamificationStore;

  constructor(dependencies: GamificationServiceDependencies) {
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#store = dependencies.store;
  }

  async recordEvent(input: GamificationEvent): Promise<RecordGamificationEventResult> {
    const event = this.#checkedEvent(input);
    const result = await this.#store.recordEvent(event);
    if (result === 'conflict') {
      throw new LearningProgressError('IDEMPOTENCY_CONFLICT', '同一奖励事件键不能表示不同事件');
    }
    return { event, status: result };
  }

  async updateEventAuthority(
    input: GamificationScope & {
      authorityState: GamificationAuthorityState;
      eventKey: string;
      sourceVersion: string;
    },
  ): Promise<void> {
    if (!TERMINAL_AUTHORITY_STATES.has(input.authorityState)) {
      throw new LearningProgressError('INPUT_INVALID', '成长事件只能单向进入争议、过期或失效状态');
    }
    const result = await this.#store.updateAuthority({
      authorityState: input.authorityState,
      eventKey: required(input.eventKey, '事件键'),
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      learningProfileId: required(input.learningProfileId, '学习档案'),
      sourceVersion: required(input.sourceVersion, '来源版本'),
    });
    if (result === 'not_found') {
      throw new LearningProgressError('GROWTH_EVENT_NOT_FOUND', '未找到需要更新的成长事件');
    }
  }

  async getGrowth(input: GamificationScope): Promise<GrowthView> {
    const scope = {
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      learningProfileId: required(input.learningProfileId, '学习档案'),
    };
    const now = this.#clock.now;
    const events = await this.#store.listEvents(scope);
    const current = events.filter(
      (event) =>
        event.authorityState === 'accepted_current' &&
        (!event.expiresAt || Date.parse(event.expiresAt) > now.getTime()),
    );
    const independent = current.filter(
      (event) => event.kind === 'learning_evidence_independent',
    ).length;
    const assisted = current.filter((event) => event.kind === 'learning_evidence_assisted').length;
    const reviewDates = new Set(
      current
        .filter((event) => event.kind === 'review_completed')
        .map((event) => event.learningDate),
    );
    const challenges = current.filter((event) => event.kind === 'safe_challenge_completed').length;
    const components = [
      component(
        'learning_evidence',
        60,
        independent * 20 + assisted * 12,
        `${independent} 条独立成功证据 ×20，${assisted} 条辅助成功证据 ×12；本项最高贡献 60 分。`,
      ),
      component(
        'review_consistency',
        30,
        reviewDates.size * 20,
        `${reviewDates.size} 个完成复习的不同学习日 ×20；本项最高贡献 30 分。`,
      ),
      component(
        'safe_participation',
        10,
        challenges * 25,
        `${challenges} 场安全完成的挑战 ×25；退出、举报、断网或错过挑战均不扣分。`,
      ),
    ];
    const xp = current.reduce((total, event) => total + XP_BY_KIND[event.kind], 0);
    const growthScore = components.reduce((total, item) => total + item.contribution, 0);
    const activityDates = current
      .filter((event) => event.kind !== 'safe_challenge_completed')
      .map((event) => event.learningDate);
    const streak = consecutiveRun(activityDates, shanghaiDate(now));
    const badges: GrowthBadgeView[] = [];
    if (independent + assisted > 0) {
      badges.push({
        key: 'first_step',
        label: '迈出第一步',
        description: '留下了第一条有效学习证据。',
      });
    }
    if (reviewDates.size >= 5) {
      badges.push({
        key: 'review_rhythm',
        label: '复习有节奏',
        description: '在五个不同学习日完成了短复习。',
      });
    }
    if (challenges > 0) {
      badges.push({
        key: 'safe_participant',
        label: '友善参与者',
        description: '安全完成了一场同伴挑战。',
      });
    }
    if (growthScore >= 50) {
      badges.push({
        key: 'steady_growth',
        label: '稳稳成长',
        description: '成长分达到 50，来自多次有效学习行动。',
      });
    }
    const expiredByTime = events.filter(
      (event) =>
        event.authorityState === 'accepted_current' &&
        event.expiresAt &&
        Date.parse(event.expiresAt) <= now.getTime(),
    ).length;
    return {
      badges,
      components,
      excludedEvents: {
        disputed: events.filter((event) => event.authorityState === 'disputed').length,
        expired:
          events.filter((event) => event.authorityState === 'expired').length + expiredByTime,
        invalidated: events.filter((event) => event.authorityState === 'invalidated').length,
        pending: events.filter((event) => event.authorityState === 'pending').length,
        shadow: events.filter((event) => event.authorityState === 'shadow').length,
      },
      generatedAt: now.toISOString(),
      growthScore,
      learningProfileId: scope.learningProfileId,
      level: Math.floor(xp / 100) + 1,
      nextLevelAtXp: (Math.floor(xp / 100) + 1) * 100,
      policy: {
        learningAccess: 'always_available',
        personalInformationRequired: false,
        purchaseRequired: false,
        ranking: 'none',
        speedAffectsScore: false,
      },
      policyVersion: 'growth-v1',
      streak: {
        ...streak,
        message: '连续学习只记录节奏；错过一天不会扣分、扣 XP 或阻止继续学习。',
      },
      xp,
    };
  }

  #checkedEvent(input: GamificationEvent): GamificationEvent {
    if (!EVENT_KINDS.has(input.kind) || !AUTHORITY_STATES.has(input.authorityState)) {
      throw new LearningProgressError('INPUT_INVALID', '成长事件类型或权威状态无效');
    }
    return {
      authorityState: input.authorityState,
      eventKey: required(input.eventKey, '事件键'),
      expiresAt: input.expiresAt ? checkedIso(input.expiresAt, '过期时间') : null,
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      kind: input.kind,
      learningDate: checkedDate(input.learningDate),
      learningProfileId: required(input.learningProfileId, '学习档案'),
      occurredAt: checkedIso(input.occurredAt, '发生时间'),
      sourceReferenceId: required(input.sourceReferenceId, '来源引用'),
      sourceVersion: required(input.sourceVersion, '来源版本'),
    };
  }
}
