import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ChallengeScreen } from '../src/challenge/ChallengeScreen';
import type {
  ChallengeGateway,
  MobileChallenge,
  MobilePartnerRelation,
} from '../src/challenge/challenge-gateway';

const relation: MobilePartnerRelation = {
  dissolvedAt: null,
  id: 'relation-1',
  participants: [
    { familySpaceId: 'family-1', learningProfileId: 'profile-1' },
    { familySpaceId: 'family-2', learningProfileId: 'profile-2' },
  ],
  status: 'active',
};

const challenge: MobileChallenge = {
  authorizationDecisionId: 'decision-1',
  capabilityVersionId: 'capability-1',
  createdAt: '2026-09-12T01:00:00.000Z',
  endedReason: null,
  evidenceQualification: 'assisted_only',
  expiresAt: null,
  id: 'challenge-1',
  items: [
    {
      difficulty: 'foundation',
      id: 'item-1',
      knowledgePoint: '加法',
      options: null,
      prompt: '1+1=?',
      response: null,
    },
  ],
  knowledgeFeedback: [],
  myProgress: { completedItems: 0, totalItems: 1 },
  mode: 'partner',
  noPenalty: true,
  opponentIdentity: null,
  opponentProgress: { completedItems: 0, totalItems: 1 },
  relationId: relation.id,
  score: null,
  speedAffectsScore: false,
  status: 'active',
  subject: 'mathematics',
  target: '今日加法',
};

function gateway(): ChallengeGateway {
  return {
    async createInvite() {
      return { code: 'ABCDEFGH2345', expiresAt: '2026-09-12T01:15:00.000Z' };
    },
    async redeemInvite() {
      return relation;
    },
    async listRelations() {
      return [relation];
    },
    async dissolveRelation() {
      return { ...relation, status: 'dissolved', dissolvedAt: '2026-09-12T01:02:00.000Z' };
    },
    async createChallenge() {
      return challenge;
    },
    async enterRandomMatch() {
      return {
        challenge: {
          ...challenge,
          expiresAt: '2026-09-13T01:00:00.000Z',
          mode: 'random',
          opponentIdentity: { avatarKey: 'safe-1', nickname: '闪亮海豚' },
          relationId: null,
        },
        grade: 3,
        status: 'matched',
      };
    },
    async listChallenges() {
      return [challenge];
    },
    async getChallenge() {
      return challenge;
    },
    async leaveChallenge() {
      return { ...challenge, endedReason: 'left', status: 'cancelled' };
    },
    async reportRandomChallenge() {
      return {
        ...challenge,
        endedReason: 'reported',
        mode: 'random',
        opponentIdentity: null,
        relationId: null,
        status: 'cancelled',
      };
    },
    async submitAnswer() {
      return {
        ...challenge,
        items: [
          {
            ...challenge.items[0]!,
            response: { answer: '2', correct: true, submittedAt: '2026-09-12T01:01:00.000Z' },
          },
        ],
        knowledgeFeedback: [{ correctItems: 1, knowledgePoint: '加法', totalItems: 1 }],
        myProgress: { completedItems: 1, totalItems: 1 },
        opponentProgress: { completedItems: 1, totalItems: 1 },
        score: { accuracy: 1, correctItems: 1, totalItems: 1 },
        status: 'completed',
      };
    },
  };
}

describe('ChallengeScreen', () => {
  it('creates an invite and clearly explains one-time, no-speed, no-penalty rules', async () => {
    const view = await render(
      <ChallengeScreen
        accessToken="token"
        familySpaceId="family-1"
        gateway={gateway()}
        learningProfileId="profile-1"
        onBack={jest.fn()}
      />,
    );
    await view.findByText('发起数学挑战');
    expect(view.getByText(/邀请码 15 分钟内一次有效/)).toBeTruthy();
    expect(view.getByText(/没有速度排名/)).toBeTruthy();
    await fireEvent.press(view.getByText('创建邀请码'));
    await view.findByText('ABCDEFGH2345');
  });

  it('resumes asynchronously, submits an objective answer, and explains assisted-only results', async () => {
    const view = await render(
      <ChallengeScreen
        accessToken="token"
        familySpaceId="family-1"
        gateway={gateway()}
        learningProfileId="profile-1"
        onBack={jest.fn()}
      />,
    );
    await view.findByText('继续');
    await fireEvent.press(view.getByText('继续'));
    expect(view.getByText(/速度不计分/)).toBeTruthy();
    await fireEvent.changeText(view.getByLabelText('我的挑战答案'), '2');
    await fireEvent.press(view.getByText('提交这一题'));
    await waitFor(() => expect(view.getByText('100%')).toBeTruthy());
    expect(view.getByText(/只作为辅助学习反馈/)).toBeTruthy();
  });

  it('shows only an ephemeral stranger identity and reports with preset reasons', async () => {
    const view = await render(
      <ChallengeScreen
        accessToken="token"
        familySpaceId="family-1"
        gateway={gateway()}
        learningProfileId="profile-1"
        onBack={jest.fn()}
      />,
    );
    await view.findByText('开始随机匹配');
    await fireEvent.press(view.getByText('开始随机匹配'));
    await view.findByText('闪亮海豚');
    expect(view.getByText(/不能聊天、搜索或查看资料/)).toBeTruthy();
    await fireEvent.press(view.getByText('这场互动让我不舒服'));
    await fireEvent.press(view.getByText('感到不舒服'));
    await view.findByText(/以后不会再匹配到对方/);
    expect(view.queryByText('闪亮海豚')).toBeNull();
  });
});
