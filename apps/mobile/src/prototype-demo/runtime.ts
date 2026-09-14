import type {
  ChallengeGateway,
  MobileChallenge,
  MobilePartnerRelation,
} from '../challenge/challenge-gateway';
import type {
  MobileLearningMaterial,
  MobileObjectiveAssessment,
  MobileProcessingJob,
  SubmissionGateway,
} from '../capture-draft/submission-gateway';
import type { MobileLearningProfile } from '../family-entry/gateway';
import type {
  GeneratedLearningGateway,
  MobileGeneratedLearningRequest,
} from '../generated-learning/generated-learning-gateway';
import type { GrowthGateway } from '../growth/growth-gateway';
import type {
  MobileReviewCard,
  MobileShortReviewSession,
  ReviewCardGateway,
} from '../review-cards/review-card-gateway';
import type { LoadTodayRoute } from '../today-route/types';

const DEMO_NOW = '2026-09-14T08:00:00.000Z';
const DEMO_FAMILY_ID = 'demo-family';
const DEMO_PROFILE_ID = 'demo-profile';
const DEMO_TOKEN = 'demo-access-token';

export interface PrototypeDemoRuntime {
  challengeGateway: ChallengeGateway;
  generatedLearningGateway: GeneratedLearningGateway;
  growthGateway: GrowthGateway;
  loadTodayRoute: LoadTodayRoute;
  reviewCardGateway: ReviewCardGateway;
  session: {
    accessToken: string;
    familySpaceId: string;
    profile: MobileLearningProfile;
  };
  submissionGateway: SubmissionGateway;
}

function demoRecognitionJob(pageId: string): MobileProcessingJob {
  const regions = [
    {
      confidence: 0.98,
      id: 'demo-question',
      kind: 'question' as const,
      lowConfidence: false,
      pageId,
      questionRegionId: null,
      readingOrder: 0,
      text: '48 ÷ 6 = ?',
    },
    {
      confidence: 0.76,
      id: 'demo-answer',
      kind: 'answer' as const,
      lowConfidence: true,
      pageId,
      questionRegionId: 'demo-question',
      readingOrder: 1,
      text: '6',
    },
  ];
  return {
    candidate: {
      adapterVersion: 'prototype-ocr-v1',
      authorization: {
        capabilityVersion: {
          adapter: { id: 'prototype-ocr-adapter', version: '1.0.0' },
          artifactHash: 'demo-artifact-hash',
          capabilityKey: 'ocr.homework',
          id: 'prototype-ocr-capability-v1',
          implementedBy: 'rhea-prototype',
          kind: 'ocr',
          modelOrEngine: { id: 'prototype-ocr', version: '1.0.0' },
          policyVersion: 'prototype-policy-v1',
          promptOrConfig: { kind: 'config', version: '1.0.0' },
          provider: { id: 'local-prototype', version: '1.0.0' },
          region: 'local-demo',
          registeredAt: DEMO_NOW,
          requiredSlicePolicyVersion: 'prototype-slice-v1',
          templateVersion: 'prototype-template-v1',
        },
        containmentEpoch: 1,
        decisionId: 'prototype-ocr-decision',
        status: 'authorized',
      },
      finishedAt: DEMO_NOW,
      id: 'demo-candidate',
      regions,
      sourceHash: 'demo-source-hash',
    },
    completedContent: null,
    errorCode: null,
    id: 'demo-processing-job',
    nextAction: null,
    qualityIssues: [],
    retryable: false,
    status: 'awaiting_confirmation',
    updatedAt: DEMO_NOW,
  };
}

function demoMaterial(
  primarySubject: 'chinese' | 'english' | 'mathematics' | 'science' | null,
): MobileLearningMaterial {
  return {
    basis: {
      currentSourceVersionId: 'demo-source-version',
      hasConflict: false,
      selectionRevision: 1,
    },
    currentClassification: {
      primarySubject,
      revision: 1,
      status: primarySubject ? 'classified' : 'pending',
    },
    id: 'demo-material',
    sourceVersions: [{ id: 'demo-source-version', versionLabel: '本次拍照确认内容 v1' }],
  };
}

function demoAssessment(): MobileObjectiveAssessment {
  return {
    currentVersion: {
      basis: {
        selectionVersion: 1,
        sourceVersionId: 'demo-source-version',
        versionLabel: '本次拍照确认内容 v1',
      },
      decision: {
        expectedDisplay: '8',
        normalizedResponse: '6',
        outcome: 'incorrect',
        reasonCode: 'answer_mismatch',
      },
      id: 'demo-assessment-version',
      question: {
        subject: 'mathematics',
        text: '48 ÷ 6 = ?',
        versionId: 'demo-question-version',
      },
      requiresProfessionalReview: false,
      response: { text: '6', versionId: 'demo-response-version' },
      revision: 1,
    },
    disputes: [],
    id: 'demo-assessment',
    openDisputeId: null,
    resolutions: [],
    versions: [{ id: 'demo-assessment-version', revision: 1 }],
  };
}

function demoGeneratedLearning(materialId: string): MobileGeneratedLearningRequest {
  return {
    aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。',
    authorizationDecision: {
      containmentEpoch: 1,
      id: 'prototype-ai-decision',
      issuedAt: DEMO_NOW,
    },
    capabilityVersion: {
      adapter: { id: 'prototype-ai-adapter', version: '1.0.0' },
      artifactHash: 'demo-ai-artifact-hash',
      capabilityKey: 'ai.generated-learning',
      id: 'prototype-ai-capability-v1',
      implementedBy: 'rhea-prototype',
      kind: 'ai',
      modelOrEngine: { id: 'prototype-tutor', version: '1.0.0' },
      policyVersion: 'prototype-policy-v1',
      promptOrConfig: { kind: 'prompt', version: '1.0.0' },
      provider: { id: 'local-prototype', version: '1.0.0' },
      region: 'local-demo',
      registeredAt: DEMO_NOW,
      requiredSlicePolicyVersion: 'prototype-slice-v1',
      templateVersion: 'prototype-template-v1',
    },
    contentState: 'direct_learning',
    createdAt: DEMO_NOW,
    degraded: null,
    familySpaceId: DEMO_FAMILY_ID,
    generatedContent: {
      fullExplanation: {
        answer: '8',
        steps: ['除法表示平均分。', '用乘法验算：6 × 8 = 48。', '所以 48 ÷ 6 = 8。'],
      },
      keyTerms: [
        { sourceRegionIds: ['demo-question'], term: '平均分' },
        { sourceRegionIds: ['demo-question'], term: '乘法验算' },
      ],
      methodHint: '想一想：6 乘几等于 48？',
      orientationHint: '先确认是在求“每份有几个”。',
      quiz: [{ id: 'demo-quiz', question: '72 ÷ 8 等于多少？' }],
      summary: {
        keyPoints: ['除法可以用对应的乘法验算。', '商 × 除数应等于被除数。'],
        title: '用乘法检查除法结果',
      },
      supplementalNotes: ['如果结果不确定，先写出对应的乘法算式。'],
      variations: [{ id: 'demo-variation', question: '把 63 支笔平均装进 9 个盒子，每盒几支？' }],
    },
    id: 'demo-generated-learning',
    learningProfileId: DEMO_PROFILE_ID,
    materialId,
    purpose: 'learning_pack',
    revealedHintLevel: 0,
    safetyGuidance: null,
    sourceVersion: {
      basisSelectionVersion: 1,
      basisSourceVersionId: 'demo-source-version',
      basisValidityEpoch: 1,
      classificationRevision: 1,
      confirmedContentVersionId: 'demo-confirmed-content',
      versionLabel: '本次拍照确认内容 v1',
    },
    status: 'ready',
    unavailableReason: null,
    updatedAt: DEMO_NOW,
  };
}

function demoReviewCard(): MobileReviewCard {
  return {
    aiGenerated: true,
    content: {
      aiContentState: 'checked',
      keyChanges: ['把原题数字 48 和 6 改为 56 和 7', '保留“平均分”和乘法验算知识点'],
      knowledgePointName: '除法验算',
      methodHint: '列出 7 的乘法口诀，找到等于 56 的一项。',
      orientationHint: '题目求的是每位同学分到的数量。',
      question: '把 56 个贴纸平均分给 7 位同学，每人能分到多少个？',
      subject: 'mathematics',
      themeId: 'demo-division-theme',
    },
    id: 'demo-review-card',
    original: {
      collapsedByDefault: true,
      currentLearningBasis: {
        sourceVersionId: 'demo-source-version',
        validityEpoch: 1,
        versionLabel: '本次拍照确认内容 v1',
      },
      question: '48 ÷ 6 = ?',
      relation: 'generated_from_wrong_item',
      response: '6',
      wrongItemId: 'demo-wrong-item',
    },
    schedule: {
      dueAt: DEMO_NOW,
      intervalDays: 1,
      pendingCorrection: true,
      stepIndex: 0,
    },
    sourceVersion: {
      assessmentVersionId: 'demo-assessment-version',
      capabilityVersionId: 'prototype-ai-capability-v1',
      classificationRevision: 1,
      wrongItemStateRevision: 1,
    },
  };
}

function makeChallenge(mode: 'partner' | 'random', relationId: string | null): MobileChallenge {
  return {
    authorizationDecisionId: 'prototype-challenge-decision',
    capabilityVersionId: 'prototype-challenge-capability-v1',
    createdAt: DEMO_NOW,
    endedReason: null,
    evidenceQualification: 'assisted_only',
    expiresAt: '2099-09-14T08:30:00.000Z',
    id: mode === 'random' ? 'demo-random-challenge' : 'demo-partner-challenge',
    items: [
      {
        difficulty: 'practice',
        id: 'demo-challenge-item',
        knowledgePoint: '除法验算',
        options: [
          { id: '6', text: '6' },
          { id: '7', text: '7' },
          { id: '8', text: '8' },
          { id: '9', text: '9' },
        ],
        prompt: '64 ÷ 8 等于多少？',
        response: null,
      },
    ],
    knowledgeFeedback: [],
    mode,
    myProgress: { completedItems: 0, totalItems: 1 },
    noPenalty: true,
    opponentIdentity: { avatarKey: 'star', nickname: '海盐星星' },
    opponentProgress: { completedItems: 0, totalItems: 1 },
    relationId,
    score: null,
    speedAffectsScore: false,
    status: 'active',
    subject: 'mathematics',
    target: '同年级 · 除法验算',
  };
}

export function createPrototypeDemoRuntime(): PrototypeDemoRuntime {
  const jobs = new Map<string, MobileProcessingJob>();
  let generated = demoGeneratedLearning('demo-material');
  const card = demoReviewCard();
  const session: MobileShortReviewSession = {
    cardIds: [card.id],
    cards: [card],
    createdAt: DEMO_NOW,
    id: 'demo-review-session',
    learningProfileId: DEMO_PROFILE_ID,
  };
  let relations: MobilePartnerRelation[] = [];
  let challenges: MobileChallenge[] = [];

  const submissionGateway: SubmissionGateway = {
    async cancel(_accessToken, id) {
      const job = jobs.get(id) ?? demoRecognitionJob('demo-page');
      const canceled = { ...job, status: 'canceled' as const, updatedAt: DEMO_NOW };
      jobs.set(id, canceled);
      return canceled;
    },
    async confirm(_accessToken, id, edits) {
      const job = jobs.get(id) ?? demoRecognitionJob('demo-page');
      const regions = job.candidate!.regions.map((region) => ({
        ...region,
        text: edits[region.id]?.trim() || region.text,
      }));
      const completed: MobileProcessingJob = {
        ...job,
        completedContent: {
          id: 'demo-confirmed-content',
          regions,
          sourceCandidateId: job.candidate!.id,
          sourceHash: job.candidate!.sourceHash,
        },
        status: 'completed',
        updatedAt: DEMO_NOW,
      };
      jobs.set(id, completed);
      return completed;
    },
    async correctClassification(input) {
      return demoMaterial(input.classification.primarySubject);
    },
    async disputeAssessment(input) {
      const assessment = demoAssessment();
      return {
        ...assessment,
        disputes: [{ id: 'demo-dispute', reviewRoute: 'guardian' }],
        openDisputeId: 'demo-dispute',
        currentVersion: {
          ...assessment.currentVersion,
          response: {
            ...assessment.currentVersion.response,
            text: input.correctionText || assessment.currentVersion.response.text,
          },
        },
      };
    },
    async getJob(_accessToken, id) {
      return jobs.get(id) ?? demoRecognitionJob('demo-page');
    },
    async gradeObjective() {
      return demoAssessment();
    },
    async organize(input) {
      return demoMaterial(input.classification.primarySubject);
    },
    async submit(input) {
      input.onProgress?.(1, input.draft.pages.length);
      const job = demoRecognitionJob(input.draft.pages[0]?.id ?? 'demo-page');
      jobs.set(job.id, job);
      return job;
    },
  };

  const generatedLearningGateway: GeneratedLearningGateway = {
    async cancel() {
      generated = {
        ...generated,
        contentState: 'unavailable',
        generatedContent: null,
        status: 'canceled',
        unavailableReason: 'GENERATION_CANCELED',
      };
      return generated;
    },
    async get() {
      return generated;
    },
    async request(input) {
      generated = demoGeneratedLearning(input.materialId);
      return generated;
    },
    async revealNextHint(input) {
      generated = {
        ...generated,
        revealedHintLevel: Math.min(3, input.expectedLevel + 1) as 0 | 1 | 2 | 3,
        updatedAt: DEMO_NOW,
      };
      return generated;
    },
  };

  const reviewCardGateway: ReviewCardGateway = {
    async createSession() {
      return session;
    },
    async getSession() {
      return session;
    },
    async submitAttempt(input) {
      const correct = input.responseText.trim() === '8';
      return {
        attempt: {
          cardId: input.cardId,
          createdAt: DEMO_NOW,
          hintLevel: input.hintLevel,
          id: 'demo-review-attempt',
          idempotencyKey: input.idempotencyKey,
          outcome: correct ? ('correct' as const) : ('incorrect' as const),
          perceivedDifficulty: input.perceivedDifficulty,
          responseText: input.responseText,
          sessionId: input.sessionId,
        },
        feedback: {
          answer: '8',
          currentState: correct ? ('theme_mastered' as const) : ('pending_correction' as const),
          evidenceQualification:
            input.hintLevel === 0 ? ('independent' as const) : ('assisted' as const),
          explanationSteps: ['56 ÷ 7 = 8，因为 7 × 8 = 56。'],
          hintImpact:
            input.hintLevel === 0 ? '这次是独立完成。' : '使用提示不会扣分，系统会安排再次练习。',
          nextAction: correct ? '这个错题主题已掌握并归档。' : '明天会用新题面再次练习。',
          nextDueAt: '2026-09-15T08:00:00.000Z',
          nextIntervalDays: 1 as const,
          outcome: correct ? ('correct' as const) : ('incorrect' as const),
        },
      };
    },
  };

  const challengeGateway: ChallengeGateway = {
    async createChallenge(input) {
      const challenge = makeChallenge('partner', input.relationId);
      challenges = [challenge, ...challenges.filter((item) => item.id !== challenge.id)];
      return challenge;
    },
    async createInvite() {
      return { code: 'RHEA-4821', expiresAt: '2099-09-14T08:15:00.000Z' };
    },
    async dissolveRelation(input) {
      const relation = relations.find((item) => item.id === input.relationId) ?? relations[0];
      const dissolved: MobilePartnerRelation = {
        ...(relation ?? {
          id: input.relationId,
          participants: [],
        }),
        dissolvedAt: DEMO_NOW,
        status: 'dissolved',
      };
      relations = relations.map((item) => (item.id === dissolved.id ? dissolved : item));
      return dissolved;
    },
    async enterRandomMatch() {
      const challenge = makeChallenge('random', null);
      challenges = [challenge, ...challenges.filter((item) => item.id !== challenge.id)];
      return { challenge, grade: 4, status: 'matched' };
    },
    async getChallenge(input) {
      return (
        challenges.find((item) => item.id === input.challengeId) ?? makeChallenge('random', null)
      );
    },
    async leaveChallenge(input) {
      const challenge = await this.getChallenge(input);
      const left = { ...challenge, endedReason: 'left' as const, status: 'cancelled' as const };
      challenges = challenges.map((item) => (item.id === left.id ? left : item));
      return left;
    },
    async listChallenges() {
      return challenges;
    },
    async listRelations() {
      return relations.filter((relation) => relation.status === 'active');
    },
    async redeemInvite() {
      const relation: MobilePartnerRelation = {
        dissolvedAt: null,
        id: 'demo-partner-relation',
        participants: [
          { familySpaceId: DEMO_FAMILY_ID, learningProfileId: DEMO_PROFILE_ID },
          { familySpaceId: 'classmate-family', learningProfileId: 'classmate-profile' },
        ],
        status: 'active',
      };
      relations = [relation];
      return relation;
    },
    async reportRandomChallenge(input) {
      const challenge = await this.getChallenge(input);
      const reported = {
        ...challenge,
        endedReason: 'reported' as const,
        status: 'cancelled' as const,
      };
      challenges = challenges.map((item) => (item.id === reported.id ? reported : item));
      return reported;
    },
    async submitAnswer(input) {
      const challenge = await this.getChallenge(input);
      const correct = input.answer.trim() === '8';
      const completed: MobileChallenge = {
        ...challenge,
        endedReason: 'completed',
        items: challenge.items.map((item) =>
          item.id === input.itemId
            ? { ...item, response: { answer: input.answer, correct, submittedAt: DEMO_NOW } }
            : item,
        ),
        knowledgeFeedback: [
          { correctItems: correct ? 1 : 0, knowledgePoint: '除法验算', totalItems: 1 },
        ],
        myProgress: { completedItems: 1, totalItems: 1 },
        opponentProgress: { completedItems: 1, totalItems: 1 },
        score: { accuracy: correct ? 1 : 0, correctItems: correct ? 1 : 0, totalItems: 1 },
        status: 'completed',
      };
      challenges = challenges.map((item) => (item.id === completed.id ? completed : item));
      return completed;
    },
  };

  return {
    challengeGateway,
    generatedLearningGateway,
    growthGateway: {
      async getGrowth() {
        return {
          badges: [
            { description: '完成一次错题订正', key: 'first-correction', label: '订正起步' },
            { description: '完成一次友好挑战', key: 'friendly-challenge', label: '并肩成长' },
          ],
          components: [
            {
              contribution: 42,
              earnedUnits: 6,
              explanation: '来自完成练习、订正错题和按期复习。',
              maximumContribution: 60,
              name: '有效学习',
              weight: 0.6,
            },
            {
              contribution: 24,
              earnedUnits: 3,
              explanation: '来自独立完成和说明自己的思路。',
              maximumContribution: 40,
              name: '独立思考',
              weight: 0.4,
            },
          ],
          growthScore: 66,
          level: 3,
          nextLevelAtXp: 90,
          policy: {
            learningAccess: 'always_available',
            personalInformationRequired: false,
            purchaseRequired: false,
            ranking: 'none',
            speedAffectsScore: false,
          },
          streak: { bestDays: 7, currentDays: 4, message: '按自己的节奏继续就好。' },
          xp: 66,
        };
      },
    },
    loadTodayRoute: async () => ({
      generatedAt: DEMO_NOW,
      items: [
        {
          action: 'confirm_content',
          count: 1,
          detail: '选择一张练习照片，体验识别、确认、批改与讲解。',
          estimatedMinutes: 3,
          explanation: '先把今天的练习变成可确认的学习内容。',
          id: 'demo-today-capture',
          isOptional: false,
          kind: 'content_confirmation',
          priority: 1,
          remainingCount: 0,
          sourceTraces: [],
          targetIds: ['demo-processing-job'],
          title: '拍一页作业并自动批改',
        },
        {
          action: 'start_review',
          count: 1,
          detail: 'AI 已根据原错题生成一个不同题面的复习卡。',
          estimatedMinutes: 2,
          explanation: '用新题面确认是否真正理解，而不是记住答案。',
          id: 'demo-today-review',
          isOptional: true,
          kind: 'due_review',
          priority: 2,
          remainingCount: 0,
          sourceTraces: [],
          targetIds: ['demo-review-card'],
          title: '用 AI 复习一个错题',
        },
        {
          action: 'start_challenge',
          count: 1,
          detail: '按四年级随机匹配，也可以创建邀请码。',
          estimatedMinutes: 3,
          explanation: '挑战只比较知识点完成情况，不比较速度。',
          id: 'demo-today-challenge',
          isOptional: true,
          kind: 'challenge',
          priority: 3,
          remainingCount: 0,
          sourceTraces: [],
          targetIds: [],
          title: '和同年级伙伴做一场挑战',
        },
      ],
      learnerProfileId: DEMO_PROFILE_ID,
      noPenaltyMessage: '跳过、退出或使用提示都不会扣分，也没有速度排名。',
      policyVersion: 'today-route-v1',
    }),
    reviewCardGateway,
    session: {
      accessToken: DEMO_TOKEN,
      familySpaceId: DEMO_FAMILY_ID,
      profile: {
        displayName: '小禾',
        familySpaceId: DEMO_FAMILY_ID,
        grade: 4,
        id: DEMO_PROFILE_ID,
      },
    },
    submissionGateway,
  };
}
