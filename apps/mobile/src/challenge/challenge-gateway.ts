export type MobileChallengeSubject = 'chinese' | 'english' | 'mathematics' | 'science';

export interface ChallengeScope {
  accessToken: string;
  familySpaceId: string;
  learningProfileId: string;
}

export interface MobilePartnerRelation {
  dissolvedAt: string | null;
  id: string;
  participants: Array<{ familySpaceId: string; learningProfileId: string }>;
  status: 'active' | 'dissolved';
}

export interface MobileChallengeItem {
  difficulty: 'foundation' | 'practice' | 'transfer';
  id: string;
  knowledgePoint: string;
  options: Array<{ id: string; text: string }> | null;
  prompt: string;
  response: null | { answer: string; correct: boolean; submittedAt: string };
}

export interface MobileChallenge {
  authorizationDecisionId: string;
  capabilityVersionId: string;
  createdAt: string;
  evidenceQualification: 'assisted_only';
  id: string;
  items: MobileChallengeItem[];
  knowledgeFeedback: Array<{
    correctItems: number;
    knowledgePoint: string;
    totalItems: number;
  }>;
  myProgress: { completedItems: number; totalItems: number };
  noPenalty: true;
  opponentProgress: { completedItems: number; totalItems: number };
  relationId: string;
  score: null | { accuracy: number; correctItems: number; totalItems: number };
  speedAffectsScore: false;
  status: 'active' | 'cancelled' | 'completed';
  subject: MobileChallengeSubject;
  target: string;
}

export interface ChallengeGateway {
  createChallenge(
    input: ChallengeScope & {
      relationId: string;
      subject: MobileChallengeSubject;
      target: string;
    },
  ): Promise<MobileChallenge>;
  createInvite(input: ChallengeScope): Promise<{ code: string; expiresAt: string }>;
  dissolveRelation(input: ChallengeScope & { relationId: string }): Promise<MobilePartnerRelation>;
  getChallenge(input: ChallengeScope & { challengeId: string }): Promise<MobileChallenge>;
  leaveChallenge(input: ChallengeScope & { challengeId: string }): Promise<MobileChallenge>;
  listChallenges(input: ChallengeScope): Promise<MobileChallenge[]>;
  listRelations(input: ChallengeScope): Promise<MobilePartnerRelation[]>;
  redeemInvite(input: ChallengeScope & { code: string }): Promise<MobilePartnerRelation>;
  submitAnswer(
    input: ChallengeScope & {
      answer: string;
      challengeId: string;
      commandId: string;
      itemId: string;
    },
  ): Promise<MobileChallenge>;
}

export class ChallengeGatewayError extends Error {
  constructor(
    readonly code: 'REQUEST_FAILED' | 'RESPONSE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ChallengeGatewayError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', `${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 4_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', `${label}格式无效`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', `${label}格式无效`);
  }
  return value as number;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', `${label}格式无效`);
  }
  return value as Values[number];
}

function relation(value: unknown): MobilePartnerRelation {
  const item = record(value, '学习伙伴关系');
  if (!Array.isArray(item.participants) || item.participants.length !== 2) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', '学习伙伴参与者格式无效');
  }
  return {
    dissolvedAt: nullableText(item.dissolvedAt, '解除时间'),
    id: text(item.id, '关系标识'),
    participants: item.participants.map((participant) => {
      const actor = record(participant, '参与者');
      return {
        familySpaceId: text(actor.familySpaceId, '家庭空间'),
        learningProfileId: text(actor.learningProfileId, '学习档案'),
      };
    }),
    status: oneOf(item.status, ['active', 'dissolved'] as const, '关系状态'),
  };
}

function progress(value: unknown) {
  const item = record(value, '挑战进度');
  const result = {
    completedItems: count(item.completedItems, '完成题数'),
    totalItems: count(item.totalItems, '总题数'),
  };
  if (result.completedItems > result.totalItems || result.totalItems > 10) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', '挑战进度不一致');
  }
  return result;
}

function challenge(value: unknown): MobileChallenge {
  const root = record(value, '挑战');
  if (!Array.isArray(root.items) || root.items.length < 1 || root.items.length > 10) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', '挑战题目格式无效');
  }
  const items = root.items.map((value) => {
    const item = record(value, '挑战题目');
    const options =
      item.options === null
        ? null
        : Array.isArray(item.options)
          ? item.options.map((value) => {
              const option = record(value, '题目选项');
              return { id: text(option.id, '选项标识'), text: text(option.text, '选项内容') };
            })
          : (() => {
              throw new ChallengeGatewayError('RESPONSE_INVALID', '题目选项格式无效');
            })();
    const response =
      item.response === null
        ? null
        : (() => {
            const answer = record(item.response, '我的作答');
            if (typeof answer.correct !== 'boolean')
              throw new ChallengeGatewayError('RESPONSE_INVALID', '作答结果格式无效');
            return {
              answer: text(answer.answer, '我的答案'),
              correct: answer.correct,
              submittedAt: text(answer.submittedAt, '提交时间'),
            };
          })();
    return {
      difficulty: oneOf(
        item.difficulty,
        ['foundation', 'practice', 'transfer'] as const,
        '题目难度',
      ),
      id: text(item.id, '题目标识'),
      knowledgePoint: text(item.knowledgePoint, '知识点'),
      options,
      prompt: text(item.prompt, '题面'),
      response,
    };
  });
  const score =
    root.score === null
      ? null
      : (() => {
          const value = record(root.score, '挑战得分');
          if (typeof value.accuracy !== 'number' || value.accuracy < 0 || value.accuracy > 1) {
            throw new ChallengeGatewayError('RESPONSE_INVALID', '正确率格式无效');
          }
          return {
            accuracy: value.accuracy,
            correctItems: count(value.correctItems, '正确题数'),
            totalItems: count(value.totalItems, '计分题数'),
          };
        })();
  if (!Array.isArray(root.knowledgeFeedback))
    throw new ChallengeGatewayError('RESPONSE_INVALID', '知识反馈格式无效');
  if (root.noPenalty !== true || root.speedAffectsScore !== false) {
    throw new ChallengeGatewayError('RESPONSE_INVALID', '挑战非惩罚或速度规则无效');
  }
  return {
    authorizationDecisionId: text(root.authorizationDecisionId, '授权决策'),
    capabilityVersionId: text(root.capabilityVersionId, '能力版本'),
    createdAt: text(root.createdAt, '创建时间'),
    evidenceQualification: oneOf(
      root.evidenceQualification,
      ['assisted_only'] as const,
      '证据资格',
    ),
    id: text(root.id, '挑战标识'),
    items,
    knowledgeFeedback: root.knowledgeFeedback.map((value) => {
      const feedback = record(value, '知识反馈');
      return {
        correctItems: count(feedback.correctItems, '知识点正确数'),
        knowledgePoint: text(feedback.knowledgePoint, '知识点'),
        totalItems: count(feedback.totalItems, '知识点题数'),
      };
    }),
    myProgress: progress(root.myProgress),
    noPenalty: true,
    opponentProgress: progress(root.opponentProgress),
    relationId: text(root.relationId, '关系标识'),
    score,
    speedAffectsScore: false,
    status: oneOf(root.status, ['active', 'cancelled', 'completed'] as const, '挑战状态'),
    subject: oneOf(
      root.subject,
      ['chinese', 'english', 'mathematics', 'science'] as const,
      '挑战学科',
    ),
    target: text(root.target, '挑战目标'),
  };
}

export function createChallengeGateway(baseUrl: string): ChallengeGateway {
  const root = baseUrl.replace(/\/$/, '');
  const endpoint = (scope: ChallengeScope, suffix: string) =>
    `${root}/v1/family-spaces/${encodeURIComponent(scope.familySpaceId)}/learning-profiles/${encodeURIComponent(scope.learningProfileId)}/${suffix}`;
  async function request(scope: ChallengeScope, suffix: string, options: RequestInit = {}) {
    const response = await fetch(endpoint(scope, suffix), {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${scope.accessToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const payload = record(await response.json(), '挑战响应');
    if (!response.ok) {
      const error = record(payload.error, '挑战错误');
      throw new ChallengeGatewayError('REQUEST_FAILED', text(error.message, '错误说明'));
    }
    return payload.data;
  }
  return {
    async createInvite(scope) {
      const value = record(await request(scope, 'partner-invites', { method: 'POST' }), '邀请码');
      const code = text(value.code, '邀请码');
      if (!/^[A-Z2-9]{12}$/.test(code))
        throw new ChallengeGatewayError('RESPONSE_INVALID', '邀请码格式无效');
      return { code, expiresAt: text(value.expiresAt, '邀请码有效期') };
    },
    async redeemInvite(input) {
      return relation(
        await request(input, 'partner-invites/redeem', {
          method: 'POST',
          body: JSON.stringify({ code: input.code }),
        }),
      );
    },
    async listRelations(scope) {
      const value = await request(scope, 'partner-relations');
      if (!Array.isArray(value))
        throw new ChallengeGatewayError('RESPONSE_INVALID', '学习伙伴列表格式无效');
      return value.map(relation);
    },
    async dissolveRelation(input) {
      return relation(
        await request(input, `partner-relations/${encodeURIComponent(input.relationId)}`, {
          method: 'DELETE',
        }),
      );
    },
    async createChallenge(input) {
      return challenge(
        await request(input, 'challenges', {
          method: 'POST',
          body: JSON.stringify({
            relationId: input.relationId,
            subject: input.subject,
            target: input.target,
          }),
        }),
      );
    },
    async listChallenges(scope) {
      const value = await request(scope, 'challenges');
      if (!Array.isArray(value))
        throw new ChallengeGatewayError('RESPONSE_INVALID', '挑战列表格式无效');
      return value.map(challenge);
    },
    async getChallenge(input) {
      return challenge(await request(input, `challenges/${encodeURIComponent(input.challengeId)}`));
    },
    async submitAnswer(input) {
      return challenge(
        await request(input, `challenges/${encodeURIComponent(input.challengeId)}/answers`, {
          method: 'POST',
          body: JSON.stringify({
            answer: input.answer,
            commandId: input.commandId,
            itemId: input.itemId,
          }),
        }),
      );
    },
    async leaveChallenge(input) {
      return challenge(
        await request(input, `challenges/${encodeURIComponent(input.challengeId)}/leave`, {
          method: 'POST',
        }),
      );
    },
  };
}
