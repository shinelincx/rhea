import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { ChallengeError } from './error.js';
import type {
  ChallengeAnswerRecord,
  ChallengeRecord,
  ChallengeStore,
  PartnerRelationRecord,
} from './store.js';
import type {
  ChallengeActor,
  ChallengeAuthorizationPort,
  ChallengeAuthorizationSnapshot,
  ChallengeGeneratedItem,
  ChallengeGeneratedPack,
  ChallengePackFactory,
  ChallengeSubject,
  ChallengeView,
  PartnerInviteView,
  PartnerRelationView,
} from './types.js';

const INVITE_LIFETIME_MS = 15 * 60_000;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SUBJECTS = new Set<ChallengeSubject>(['chinese', 'english', 'mathematics', 'science']);

export interface ChallengeServiceDependencies {
  authorization: ChallengeAuthorizationPort;
  clock?: { readonly now: Date };
  invitationPepper: string;
  packFactory: ChallengePackFactory;
  store: ChallengeStore;
}

function required(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ChallengeError('INPUT_INVALID', `${label}不能为空且不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

function numeric(value: string): string | null {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? String(number) : null;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function grade(item: ChallengeGeneratedItem, answer: string): boolean {
  if (item.gradingRule.kind === 'numeric') {
    const actual = numeric(answer);
    const expected = numeric(item.gradingRule.expected);
    return actual !== null && expected !== null && actual === expected;
  }
  if (item.gradingRule.kind === 'single_choice') {
    return normalize(answer) === normalize(item.gradingRule.correctOptionId);
  }
  throw new ChallengeError('GENERATED_PACK_INVALID', '挑战题包包含不能确定性批改的题目');
}

function publicRelation(record: PartnerRelationRecord): PartnerRelationView {
  const { dissolvedAt, id, participants, status } = record;
  return { dissolvedAt, id, participants: structuredClone(participants), status };
}

export class ChallengeService {
  readonly #authorization: ChallengeAuthorizationPort;
  readonly #clock: { readonly now: Date };
  readonly #invitationPepper: string;
  readonly #packFactory: ChallengePackFactory;
  readonly #store: ChallengeStore;

  constructor(dependencies: ChallengeServiceDependencies) {
    if (dependencies.invitationPepper.length < 24) {
      throw new ChallengeError('INPUT_INVALID', '邀请码保护密钥至少需要 24 个字符');
    }
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#invitationPepper = dependencies.invitationPepper;
    this.#packFactory = dependencies.packFactory;
    this.#store = dependencies.store;
  }

  async createPartnerInvite(input: { actor: ChallengeActor }): Promise<PartnerInviteView> {
    await this.#requireAuthorized(input.actor);
    const code = this.#issueCode();
    const now = this.#clock.now;
    const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS).toISOString();
    await this.#store.saveInvite({
      codeHash: this.#codeHash(code),
      consumedAt: null,
      createdAt: now.toISOString(),
      creator: structuredClone(input.actor),
      expiresAt,
      id: randomUUID(),
      relationId: null,
    });
    return { code, expiresAt };
  }

  async redeemPartnerInvite(input: {
    actor: ChallengeActor;
    code: string;
  }): Promise<PartnerRelationView> {
    const code = normalizeCode(input.code);
    if (!/^[A-Z2-9]{12}$/.test(code)) {
      throw new ChallengeError('INVITE_INVALID', '邀请码无效，请核对后再试');
    }
    const codeHash = this.#codeHash(code);
    const invite = await this.#store.findInviteByHash(codeHash);
    if (!invite) throw new ChallengeError('INVITE_INVALID', '邀请码无效，请核对后再试');
    if (invite.creator.learningProfileId === input.actor.learningProfileId) {
      throw new ChallengeError('INVITE_SELF_USE', '不能使用自己创建的邀请码');
    }
    if (invite.consumedAt) {
      throw new ChallengeError('INVITE_ALREADY_USED', '这个邀请码已经使用过，请让同学重新创建');
    }
    if (Date.parse(invite.expiresAt) <= this.#clock.now.getTime()) {
      throw new ChallengeError('INVITE_EXPIRED', '这个邀请码已过期，请让同学重新创建');
    }
    const [creatorAuthorization, redeemerAuthorization] = await Promise.all([
      this.#requireAuthorized(invite.creator),
      this.#requireAuthorized(input.actor),
    ]);
    if (creatorAuthorization.grade !== redeemerAuthorization.grade) {
      throw new ChallengeError('GRADE_MISMATCH', '邀请码只可由同年级学习者使用');
    }
    const now = this.#clock.now.toISOString();
    const relation: PartnerRelationRecord = {
      createdAt: now,
      dissolvedAt: null,
      id: randomUUID(),
      participants: [structuredClone(invite.creator), structuredClone(input.actor)],
      status: 'active',
    };
    const outcome = await this.#store.consumeInvite({
      authorizationSnapshots: [creatorAuthorization, redeemerAuthorization].map((snapshot) => ({
        consentRevision: snapshot.consentRevision,
        familySpaceId: snapshot.familySpaceId,
        grade: snapshot.grade!,
        learningProfileId: snapshot.learningProfileId,
      })),
      codeHash,
      consumedAt: now,
      inviteId: invite.id,
      relation,
    });
    if (outcome.kind === 'already_used') {
      throw new ChallengeError('INVITE_ALREADY_USED', '这个邀请码已经使用过，请让同学重新创建');
    }
    if (outcome.kind === 'expired') {
      throw new ChallengeError('INVITE_EXPIRED', '这个邀请码已过期，请让同学重新创建');
    }
    if (outcome.kind === 'not_found') {
      throw new ChallengeError('INVITE_INVALID', '邀请码无效，请核对后再试');
    }
    return publicRelation(outcome.relation);
  }

  async listPartnerRelations(input: { actor: ChallengeActor }): Promise<PartnerRelationView[]> {
    await this.#requireAuthorized(input.actor);
    return (await this.#store.listRelations(input.actor.learningProfileId)).map(publicRelation);
  }

  async createChallenge(input: {
    actor: ChallengeActor;
    relationId: string;
    subject: ChallengeSubject;
    target: string;
  }): Promise<ChallengeView> {
    const relation = await this.#relationForParticipant(input.relationId, input.actor);
    if (relation.status !== 'active') {
      throw new ChallengeError('PARTNER_RELATION_INACTIVE', '学习伙伴关系已解除，不能创建新挑战');
    }
    if (!SUBJECTS.has(input.subject)) {
      throw new ChallengeError('INPUT_INVALID', '挑战学科无效');
    }
    const snapshots = await Promise.all(
      relation.participants.map((participant) => this.#requireAuthorized(participant)),
    );
    const gradeValue = snapshots[0]?.grade;
    if (!gradeValue || snapshots.some((snapshot) => snapshot.grade !== gradeValue)) {
      throw new ChallengeError('GRADE_MISMATCH', '双方年级必须一致才能创建挑战');
    }
    const target = required(input.target, '挑战目标');
    const generated = await this.#packFactory.createEquivalentPacks({
      grade: gradeValue,
      participants: structuredClone(relation.participants),
      subject: input.subject,
      target,
    });
    this.#validatePacks(generated, relation);
    const publicationSnapshots = await Promise.all(
      relation.participants.map((participant) => this.#requireAuthorized(participant)),
    );
    if (publicationSnapshots.some((snapshot) => snapshot.grade !== gradeValue)) {
      throw new ChallengeError('GRADE_MISMATCH', '题包发布前双方年级发生变化，请重新发起挑战');
    }
    const now = this.#clock.now.toISOString();
    const record: ChallengeRecord = {
      answers: [],
      authorizationDecisionId: required(generated.authorizationDecisionId, '题包授权决策'),
      authorizationSnapshots: publicationSnapshots.map((snapshot) => ({
        consentRevision: snapshot.consentRevision,
        familySpaceId: snapshot.familySpaceId,
        grade: snapshot.grade!,
        learningProfileId: snapshot.learningProfileId,
      })),
      capabilityVersionId: required(generated.capabilityVersionId, '题包能力版本'),
      cancelledAt: null,
      cancelledByProfileId: null,
      createdAt: now,
      id: randomUUID(),
      packs: structuredClone(generated.packs),
      relationId: relation.id,
      status: 'active',
      subject: input.subject,
      target,
      version: 1,
    };
    if (!(await this.#store.saveChallenge(record, null))) {
      const currentRelation = await this.#store.findRelation(
        relation.id,
        input.actor.learningProfileId,
      );
      if (currentRelation?.status !== 'active') {
        throw new ChallengeError('PARTNER_RELATION_INACTIVE', '学习伙伴关系已解除，不能创建新挑战');
      }
      throw new ChallengeError('WRITE_CONFLICT', '挑战创建冲突，请重试');
    }
    return this.#view(record, input.actor);
  }

  async getChallenge(input: {
    actor: ChallengeActor;
    challengeId: string;
  }): Promise<ChallengeView> {
    const record = await this.#challengeForParticipant(input.challengeId, input.actor);
    return this.#view(record, input.actor);
  }

  async listChallenges(input: { actor: ChallengeActor }): Promise<ChallengeView[]> {
    return Promise.all(
      (await this.#store.listChallenges(input.actor.learningProfileId)).map(async (challenge) =>
        this.#view(challenge, input.actor),
      ),
    );
  }

  async submitAnswer(input: {
    actor: ChallengeActor;
    answer: string;
    challengeId: string;
    commandId: string;
    itemId: string;
  }): Promise<ChallengeView> {
    const challenge = await this.#challengeForParticipant(input.challengeId, input.actor);
    const duplicate = challenge.answers.find(
      (answer) =>
        answer.learningProfileId === input.actor.learningProfileId &&
        answer.commandId === input.commandId,
    );
    if (duplicate) return this.#view(challenge, input.actor);
    if (challenge.status !== 'active') {
      throw new ChallengeError('CHALLENGE_NOT_ACTIVE', '这场挑战已经结束，不能继续作答');
    }
    const relation = await this.#relationForParticipant(challenge.relationId, input.actor);
    if (relation.status !== 'active') {
      throw new ChallengeError('PARTNER_RELATION_INACTIVE', '学习伙伴关系已解除，挑战已经结束');
    }
    await Promise.all(
      relation.participants.map((participant) => this.#requireAuthorized(participant)),
    );
    const pack = challenge.packs.find(
      (candidate) => candidate.learningProfileId === input.actor.learningProfileId,
    )!;
    const itemId = required(input.itemId, '挑战题目');
    const item = pack.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new ChallengeError('ITEM_NOT_FOUND', '这道题不在你的挑战题包中');
    if (
      challenge.answers.some(
        (answer) =>
          answer.learningProfileId === input.actor.learningProfileId && answer.itemId === itemId,
      )
    ) {
      throw new ChallengeError('ITEM_ALREADY_ANSWERED', '这道题已经提交，不能重复计分');
    }
    const answer = required(input.answer, '答案', 500);
    const attempt: ChallengeAnswerRecord = {
      answer,
      commandId: required(input.commandId, '提交命令'),
      correct: grade(item, answer),
      itemId,
      learningProfileId: input.actor.learningProfileId,
      submittedAt: this.#clock.now.toISOString(),
    };
    const updated = structuredClone(challenge);
    updated.answers.push(attempt);
    updated.version += 1;
    if (
      updated.packs.every(
        (candidate) =>
          updated.answers.filter((entry) => entry.learningProfileId === candidate.learningProfileId)
            .length === candidate.items.length,
      )
    ) {
      updated.status = 'completed';
    }
    if (!(await this.#store.saveChallenge(updated, challenge.version))) {
      const latest = await this.#store.getChallenge(challenge.id, input.actor.learningProfileId);
      if (
        latest?.answers.some(
          (entry) =>
            entry.learningProfileId === input.actor.learningProfileId &&
            entry.commandId === input.commandId,
        )
      ) {
        return this.#view(latest, input.actor);
      }
      throw new ChallengeError('WRITE_CONFLICT', '有新的作答已提交，请刷新后继续');
    }
    return this.#view(updated, input.actor);
  }

  async leaveChallenge(input: {
    actor: ChallengeActor;
    challengeId: string;
  }): Promise<ChallengeView> {
    const challenge = await this.#challengeForParticipant(input.challengeId, input.actor);
    if (challenge.status !== 'active') return this.#view(challenge, input.actor);
    const updated = structuredClone(challenge);
    updated.cancelledAt = this.#clock.now.toISOString();
    updated.cancelledByProfileId = input.actor.learningProfileId;
    updated.status = 'cancelled';
    updated.version += 1;
    if (!(await this.#store.saveChallenge(updated, challenge.version))) {
      throw new ChallengeError('WRITE_CONFLICT', '挑战状态已经变化，请刷新');
    }
    return this.#view(updated, input.actor);
  }

  async dissolvePartnerRelation(input: {
    actor: ChallengeActor;
    relationId: string;
  }): Promise<PartnerRelationView> {
    const relation = await this.#relationForParticipant(input.relationId, input.actor);
    if (relation.status === 'dissolved') return publicRelation(relation);
    const dissolvedAt = this.#clock.now.toISOString();
    const updated: PartnerRelationRecord = {
      ...relation,
      dissolvedAt,
      status: 'dissolved',
    };
    await this.#store.saveRelation(updated);
    const active = (await this.#store.listChallenges(input.actor.learningProfileId)).filter(
      (challenge) => challenge.relationId === relation.id && challenge.status === 'active',
    );
    await Promise.all(
      active.map(async (challenge) => {
        const cancelled = {
          ...challenge,
          cancelledAt: dissolvedAt,
          cancelledByProfileId: input.actor.learningProfileId,
          status: 'cancelled' as const,
          version: challenge.version + 1,
        };
        if (!(await this.#store.saveChallenge(cancelled, challenge.version))) {
          throw new ChallengeError('WRITE_CONFLICT', '关系状态已经变化，请刷新');
        }
      }),
    );
    return publicRelation(updated);
  }

  async #requireAuthorized(actor: ChallengeActor): Promise<ChallengeAuthorizationSnapshot> {
    const snapshot = await this.#authorization.getChallengeAuthorization(actor);
    if (!snapshot || snapshot.status !== 'granted') {
      throw new ChallengeError(
        'CHALLENGE_CONSENT_REQUIRED',
        '同伴挑战尚未获得授权，请由监护人在设置中开启',
      );
    }
    if (!snapshot.grade) {
      throw new ChallengeError('GRADE_REQUIRED', '请由监护人先设置学习年级');
    }
    if (
      snapshot.familySpaceId !== actor.familySpaceId ||
      snapshot.learningProfileId !== actor.learningProfileId
    ) {
      throw new ChallengeError('ACCESS_DENIED', '挑战授权与学习档案不匹配');
    }
    return snapshot;
  }

  async #relationForParticipant(
    relationId: string,
    actor: ChallengeActor,
  ): Promise<PartnerRelationRecord> {
    const relation = await this.#store.findRelation(
      required(relationId, '学习伙伴关系'),
      actor.learningProfileId,
    );
    if (!relation) {
      throw new ChallengeError('PARTNER_RELATION_NOT_FOUND', '学习伙伴关系不存在');
    }
    if (
      !relation.participants.some((entry) => entry.learningProfileId === actor.learningProfileId)
    ) {
      throw new ChallengeError('ACCESS_DENIED', '不能访问其他学习者的伙伴关系');
    }
    return relation;
  }

  async #challengeForParticipant(
    challengeId: string,
    actor: ChallengeActor,
  ): Promise<ChallengeRecord> {
    const challenge = await this.#store.getChallenge(
      required(challengeId, '挑战'),
      actor.learningProfileId,
    );
    if (!challenge) throw new ChallengeError('CHALLENGE_NOT_FOUND', '挑战不存在');
    if (!challenge.packs.some((pack) => pack.learningProfileId === actor.learningProfileId)) {
      throw new ChallengeError('ACCESS_DENIED', '不能访问其他学习者的挑战');
    }
    return challenge;
  }

  #issueCode(): string {
    const bytes = randomBytes(12);
    return [...bytes].map((byte) => INVITE_ALPHABET[byte! % INVITE_ALPHABET.length]).join('');
  }

  #codeHash(code: string): string {
    return createHmac('sha256', this.#invitationPepper).update(code).digest('base64url');
  }

  #validatePacks(
    generated: {
      authorizationDecisionId: string;
      capabilityVersionId: string;
      packs: ChallengeGeneratedPack[];
    },
    relation: PartnerRelationRecord,
  ): void {
    if (!generated.authorizationDecisionId.trim() || !generated.capabilityVersionId.trim()) {
      throw new ChallengeError('GENERATED_PACK_INVALID', '挑战题包缺少获准能力版本');
    }
    if (generated.packs.length !== 2) {
      throw new ChallengeError('GENERATED_PACK_INVALID', '挑战必须为双方各生成一个独立题包');
    }
    const packs = relation.participants.map((participant) =>
      generated.packs.find((pack) => pack.learningProfileId === participant.learningProfileId),
    );
    if (packs.some((pack) => !pack)) {
      throw new ChallengeError('GENERATED_PACK_INVALID', '挑战题包与参与者不匹配');
    }
    const [first, second] = packs as [ChallengeGeneratedPack, ChallengeGeneratedPack];
    if (
      first.items.length < 1 ||
      first.items.length > 10 ||
      first.items.length !== second.items.length
    ) {
      throw new ChallengeError('GENERATED_PACK_INVALID', '双方挑战题量必须一致且为 1 至 10 题');
    }
    for (let index = 0; index < first.items.length; index += 1) {
      const left = first.items[index]!;
      const right = second.items[index]!;
      if (
        !left.id.trim() ||
        !right.id.trim() ||
        !left.prompt.trim() ||
        !right.prompt.trim() ||
        left.prompt.trim() === right.prompt.trim() ||
        left.difficulty !== right.difficulty ||
        left.knowledgePoint.trim() !== right.knowledgePoint.trim() ||
        left.gradingRule.kind === 'accepted_text' ||
        right.gradingRule.kind === 'accepted_text'
      ) {
        throw new ChallengeError(
          'GENERATED_PACK_INVALID',
          '双方题包必须目标、题量和难度等价，且仅包含不同题面的客观题',
        );
      }
      for (const item of [left, right]) {
        if (item.gradingRule.kind === 'numeric' && numeric(item.gradingRule.expected) === null) {
          throw new ChallengeError('GENERATED_PACK_INVALID', '数值题评分规则无效');
        }
        if (item.gradingRule.kind === 'single_choice' && !this.#hasValidChoiceRule(item)) {
          throw new ChallengeError('GENERATED_PACK_INVALID', '选择题评分规则无效');
        }
      }
    }
  }

  #hasValidChoiceRule(item: ChallengeGeneratedItem): boolean {
    if (item.gradingRule.kind !== 'single_choice') return false;
    const correctOptionId = item.gradingRule.correctOptionId;
    return Boolean(
      item.options &&
      item.options.length >= 2 &&
      item.options.some((option) => option.id === correctOptionId),
    );
  }

  #view(challenge: ChallengeRecord, actor: ChallengeActor): ChallengeView {
    const pack = challenge.packs.find(
      (candidate) => candidate.learningProfileId === actor.learningProfileId,
    );
    if (!pack) throw new ChallengeError('ACCESS_DENIED', '不能访问其他学习者的挑战');
    const opponentPack = challenge.packs.find(
      (candidate) => candidate.learningProfileId !== actor.learningProfileId,
    )!;
    const ownAnswers = challenge.answers.filter(
      (answer) => answer.learningProfileId === actor.learningProfileId,
    );
    const opponentAnswers = challenge.answers.filter(
      (answer) => answer.learningProfileId === opponentPack.learningProfileId,
    );
    const completed = challenge.status === 'completed';
    const correctItems = ownAnswers.filter((answer) => answer.correct).length;
    const knowledgeFeedback = completed
      ? pack.items.map((item) => {
          const answer = ownAnswers.find((entry) => entry.itemId === item.id);
          return {
            correctItems: answer?.correct ? 1 : 0,
            knowledgePoint: item.knowledgePoint,
            totalItems: 1,
          };
        })
      : [];
    return {
      authorizationDecisionId: challenge.authorizationDecisionId,
      capabilityVersionId: challenge.capabilityVersionId,
      createdAt: challenge.createdAt,
      evidenceQualification: 'assisted_only',
      id: challenge.id,
      items: pack.items.map((item) => {
        const response = ownAnswers.find((answer) => answer.itemId === item.id);
        return {
          difficulty: item.difficulty,
          id: item.id,
          knowledgePoint: item.knowledgePoint,
          options: item.options ? structuredClone(item.options) : null,
          prompt: item.prompt,
          response: response
            ? {
                answer: response.answer,
                correct: response.correct,
                submittedAt: response.submittedAt,
              }
            : null,
        };
      }),
      knowledgeFeedback,
      myProgress: { completedItems: ownAnswers.length, totalItems: pack.items.length },
      noPenalty: true,
      opponentProgress: {
        completedItems: opponentAnswers.length,
        totalItems: opponentPack.items.length,
      },
      relationId: challenge.relationId,
      score: completed
        ? {
            accuracy: correctItems / pack.items.length,
            correctItems,
            totalItems: pack.items.length,
          }
        : null,
      speedAffectsScore: false,
      status: challenge.status,
      subject: challenge.subject,
      target: challenge.target,
    };
  }
}
