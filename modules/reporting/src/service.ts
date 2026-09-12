import { ReportingError } from './error.js';
import { buildGuardianTodos, buildLearningReport, buildTodayRouteItems } from './policy.js';
import type { ReportingStore } from './store.js';
import type { GuardianReportView, ReportingActor, TodayRouteView } from './types.js';

export interface ReportingServiceDependencies {
  clock?: { readonly now: Date };
  store: ReportingStore;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new ReportingError('INPUT_INVALID', `${label}不能为空且不能超过 200 个字符`);
  }
  return normalized;
}

export class ReportingService {
  readonly #clock: { readonly now: Date };
  readonly #store: ReportingStore;

  constructor(dependencies: ReportingServiceDependencies) {
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#store = dependencies.store;
  }

  async getTodayRoute(input: {
    actor: ReportingActor;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<TodayRouteView> {
    const scope = this.#scope(input);
    if (input.actor.type === 'learner' && input.actor.id !== scope.learningProfileId) {
      throw new ReportingError('ACCESS_DENIED', '不能查看其他学习档案的今日路线');
    }
    const generatedAt = this.#clock.now.toISOString();
    const candidates = await this.#store.readTodayRouteCandidates(scope, generatedAt);
    return {
      generatedAt,
      items: buildTodayRouteItems(candidates),
      learnerProfileId: scope.learningProfileId,
      noPenaltyMessage: '今日路线可以调整，跳过或稍后完成不会扣分、扣 XP 或中断连续学习。',
      policyVersion: 'today-route-v1',
    };
  }

  async getGuardianReport(input: {
    actor: ReportingActor;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<GuardianReportView> {
    if (input.actor.type !== 'guardian') {
      throw new ReportingError('GUARDIAN_REQUIRED', '学习报告和监护待办仅在监护人模式中提供');
    }
    const scope = this.#scope(input);
    const generatedAt = this.#clock.now.toISOString();
    const from = new Date(this.#clock.now.getTime() - 27 * 24 * 60 * 60 * 1_000).toISOString();
    const [guardianTodos, facts] = await Promise.all([
      this.#store.readGuardianTodoCandidates(scope, generatedAt),
      this.#store.readLearningReportFacts(scope, { from, to: generatedAt }),
    ]);
    return {
      generatedAt,
      learnerProfileId: scope.learningProfileId,
      learningReport: buildLearningReport({
        facts,
        from,
        generatedAt,
        learningProfileId: scope.learningProfileId,
        to: generatedAt,
      }),
      todos: buildGuardianTodos(guardianTodos),
    };
  }

  #scope(input: { familySpaceId: string; learningProfileId: string }) {
    return {
      familySpaceId: required(input.familySpaceId, '家庭空间'),
      learningProfileId: required(input.learningProfileId, '学习档案'),
    };
  }
}
