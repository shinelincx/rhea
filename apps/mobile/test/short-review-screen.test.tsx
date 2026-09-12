import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ShortReviewScreen } from '../src/review-cards/ShortReviewScreen';
import type { MobileReviewCard, ReviewCardGateway } from '../src/review-cards/review-card-gateway';

const card: MobileReviewCard = {
  aiGenerated: true,
  content: {
    aiContentState: 'checked',
    keyChanges: ['把两个加数改成 30 和 12'],
    knowledgePointName: '两位数加法',
    methodHint: '把两个加数按数位对齐。',
    orientationHint: '想一想个位怎样相加。',
    question: '30 + 12 等于多少？',
    subject: 'mathematics',
    themeId: 'theme-1',
  },
  id: 'card-1',
  original: {
    collapsedByDefault: true,
    currentLearningBasis: {
      sourceVersionId: 'basis-1',
      validityEpoch: 1,
      versionLabel: '老师答案 v1',
    },
    question: '40 + 2 等于多少？',
    relation: 'generated_from_wrong_item',
    response: '41',
    wrongItemId: 'wrong-1',
  },
  schedule: {
    dueAt: '2026-09-12T00:00:00.000Z',
    intervalDays: 1,
    pendingCorrection: true,
    stepIndex: 0,
  },
  sourceVersion: {
    assessmentVersionId: 'assessment-1',
    capabilityVersionId: 'capability-1',
    classificationRevision: 1,
    wrongItemStateRevision: 1,
  },
};

describe('ShortReviewScreen', () => {
  it('progressively reveals help, keeps the answer hidden until feedback, and ends clearly', async () => {
    const gateway: ReviewCardGateway = {
      async createSession() {
        return {
          cardIds: [card.id],
          cards: [card],
          createdAt: '2026-09-12T00:00:00.000Z',
          id: 'session-1',
          learningProfileId: 'profile-1',
        };
      },
      async getSession() {
        throw new Error('not used');
      },
      async submitAttempt(input) {
        return {
          attempt: {
            cardId: card.id,
            createdAt: '2026-09-12T00:01:00.000Z',
            hintLevel: input.hintLevel,
            id: 'attempt-1',
            idempotencyKey: input.idempotencyKey,
            outcome: 'correct',
            perceivedDifficulty: input.perceivedDifficulty,
            responseText: input.responseText,
            sessionId: 'session-1',
          },
          feedback: {
            answer: '42',
            currentState: 'theme_mastered',
            evidenceQualification: 'assisted',
            explanationSteps: ['30 + 12 = 42。'],
            hintImpact: '本次使用了方法提示，次日重新安排无提示变式。',
            nextAction: '这个错题主题已掌握并从活跃错题队列归档。',
            nextDueAt: '2026-09-13T00:01:00.000Z',
            nextIntervalDays: 1,
            outcome: 'correct',
          },
        };
      },
    };
    const screen = await render(
      <ShortReviewScreen
        accessToken="token-1"
        familySpaceId="family-1"
        gateway={gateway}
        learningProfileId="profile-1"
        onBack={jest.fn()}
      />,
    );
    await screen.findByText('30 + 12 等于多少？');
    expect(screen.getByText('待订正 · 今日优先')).toBeTruthy();
    expect(screen.queryByText(/参考答案/)).toBeNull();
    expect(screen.queryByText('40 + 2 等于多少？')).toBeNull();

    await fireEvent.press(screen.getByText('查看原题与依据'));
    expect(screen.getByText('40 + 2 等于多少？')).toBeTruthy();
    expect(screen.queryByText(/参考答案/)).toBeNull();
    await fireEvent.press(screen.getByText('看定位提示'));
    expect(screen.getByText('想一想个位怎样相加。')).toBeTruthy();
    await fireEvent.press(screen.getByText('再看方法提示'));
    expect(screen.getByText('把两个加数按数位对齐。')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('我的答案'), '42');
    await fireEvent.press(screen.getByText('有点难'));
    await fireEvent.press(screen.getByText('提交答案'));
    await screen.findByText('参考答案：42');
    expect(screen.getByText('这个主题已掌握')).toBeTruthy();
    expect(screen.getByText('已掌握 · 已归档')).toBeTruthy();
    expect(screen.getByText(/次日重新安排/)).toBeTruthy();
    await fireEvent.press(screen.getByText('完成本次复习'));
    await waitFor(() => expect(screen.getByText('本次复习完成')).toBeTruthy());
    expect(screen.getByText(/已完成 1 张/)).toBeTruthy();
  });
});
