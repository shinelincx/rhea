import { render, waitFor } from '@testing-library/react-native';
import { GrowthScreen } from '../src/growth/GrowthScreen';

describe('GrowthScreen', () => {
  it('shows explainable personal growth without ranks, speed, payment, or failure penalties', async () => {
    const screen = await render(
      <GrowthScreen
        accessToken="token"
        familySpaceId="family-1"
        learningProfileId="profile-1"
        onBack={() => undefined}
        gateway={{
          async getGrowth() {
            return {
              badges: [
                {
                  description: '留下了第一条有效学习证据。',
                  key: 'first_step',
                  label: '迈出第一步',
                },
              ],
              components: [
                {
                  contribution: 24,
                  earnedUnits: 40,
                  explanation: '2 条独立成功证据 ×20；本项最高贡献 60 分。',
                  maximumContribution: 60,
                  name: 'learning_evidence',
                  weight: 60,
                },
                {
                  contribution: 6,
                  earnedUnits: 20,
                  explanation: '1 个完成复习的不同学习日 ×20；本项最高贡献 30 分30分。',
                  maximumContribution: 30,
                  name: 'review_consistency',
                  weight: 30,
                },
                {
                  contribution: 0,
                  earnedUnits: 0,
                  explanation: '0 场；退出、举报、断网或错过挑战均不扣分。',
                  maximumContribution: 10,
                  name: 'safe_participation',
                  weight: 10,
                },
              ],
              growthScore: 30,
              level: 1,
              nextLevelAtXp: 100,
              policy: {
                learningAccess: 'always_available',
                personalInformationRequired: false,
                purchaseRequired: false,
                ranking: 'none',
                speedAffectsScore: false,
              },
              streak: {
                bestDays: 1,
                currentDays: 1,
                message: '错过一天不会扣分、扣 XP 或阻止继续学习。',
              },
              xp: 55,
            };
          },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText('30')).toBeTruthy());
    expect(screen.getByText('学习证据 · 60%')).toBeTruthy();
    expect(screen.getByText('复习坚持 · 30%')).toBeTruthy();
    expect(screen.getByText(/没有全网排名或速度榜/)).toBeTruthy();
    expect(screen.queryByText(/购买|付费解锁/)).toBeNull();
  });
});
