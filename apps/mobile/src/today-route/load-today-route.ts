import type { FetchTodayRoute, TodayRoute } from './types';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  return value;
}

function count(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label}格式无效`);
  }
  return value as number;
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}格式无效`);
  return value;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label}格式无效`);
  return value as Values[number];
}

function route(value: unknown, expectedProfileId: string): TodayRoute {
  const root = record(value, '今日路线');
  if (!Array.isArray(root.items) || root.items.length > 5) throw new Error('今日路线项目格式无效');
  const items = root.items.map((value) => {
    const item = record(value, '今日路线项目');
    if (!Array.isArray(item.targetIds) || !Array.isArray(item.sourceTraces)) {
      throw new Error('今日路线来源格式无效');
    }
    const targetIds = item.targetIds.map((target) => text(target, '路线目标'));
    const itemCount = count(item.count, '路线项目数量', 1);
    if (targetIds.length !== itemCount || item.sourceTraces.length !== itemCount) {
      throw new Error('今日路线项目数量与来源不一致');
    }
    return {
      action: oneOf(
        item.action,
        [
          'confirm_content',
          'correct_wrong_item',
          'resume_learning',
          'review_result',
          'start_challenge',
          'start_review',
          'start_variation',
        ] as const,
        '路线操作',
      ),
      count: itemCount,
      detail: text(item.detail, '路线说明'),
      estimatedMinutes: count(item.estimatedMinutes, '预计时长', 1),
      explanation: text(item.explanation, '路线原因'),
      id: text(item.id, '路线标识'),
      isOptional: flag(item.isOptional, '路线可选状态'),
      kind: oneOf(
        item.kind,
        [
          'challenge',
          'content_confirmation',
          'due_review',
          'result_review',
          'resume_learning',
          'variation_practice',
          'wrong_item_correction',
        ] as const,
        '路线类型',
      ),
      priority: count(item.priority, '路线优先级', 1),
      remainingCount: count(item.remainingCount, '剩余项目数量'),
      sourceTraces: item.sourceTraces,
      targetIds,
      title: text(item.title, '路线标题'),
    };
  });
  const learnerProfileId = text(root.learnerProfileId, '学习档案');
  if (learnerProfileId !== expectedProfileId) throw new Error('今日路线学习档案不匹配');
  return {
    generatedAt: text(root.generatedAt, '路线生成时间'),
    items,
    learnerProfileId,
    noPenaltyMessage: text(root.noPenaltyMessage, '路线规则'),
    policyVersion: oneOf(root.policyVersion, ['today-route-v1'] as const, '路线版本'),
  };
}

export function createTodayRouteLoader(baseUrl: string): FetchTodayRoute {
  const root = baseUrl.replace(/\/$/, '');
  return async (input) => {
    const endpoint = `${root}/v1/family-spaces/${encodeURIComponent(
      input.familySpaceId,
    )}/learning-profiles/${encodeURIComponent(input.learningProfileId)}/today-route`;
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Today route request failed with ${response.status}`);
    }

    const envelope = record(await response.json(), '今日路线响应');
    return route(envelope.data, input.learningProfileId);
  };
}
