import { fireEvent, render } from '@testing-library/react-native';

import { TodayRouteScreen } from '../src/today-route/TodayRouteScreen';

describe('Today route mobile interface', () => {
  it('shows the empty route returned by the backend', async () => {
    const view = await render(
      <TodayRouteScreen
        loadRoute={async () => ({
          generatedAt: '2026-09-09T00:00:00.000Z',
          items: [],
          learnerProfileId: 'profile-1',
          noPenaltyMessage: '跳过或稍后完成不会扣分。',
          policyVersion: 'today-route-v1',
        })}
      />,
    );

    expect(await view.findByText('今天没有待办')).toBeVisible();
    expect(view.getByText('想学习时，拍一页练习就能开始。')).toBeVisible();
  });

  it('starts the assignment capture flow from an empty day', async () => {
    const onStartCapture = jest.fn();
    const view = await render(
      <TodayRouteScreen
        loadRoute={async () => ({
          generatedAt: '2026-09-09T00:00:00.000Z',
          items: [],
          learnerProfileId: 'profile-1',
          noPenaltyMessage: '跳过或稍后完成不会扣分。',
          policyVersion: 'today-route-v1',
        })}
        onStartCapture={onStartCapture}
      />,
    );

    await fireEvent.press(await view.findByRole('button', { name: '拍照或导入作业' }));
    expect(onStartCapture).toHaveBeenCalledTimes(1);
  });

  it('shows a short explainable route and starts the matching action', async () => {
    const onStartCapture = jest.fn();
    const onStartReview = jest.fn();
    const view = await render(
      <TodayRouteScreen
        loadRoute={async () => ({
          generatedAt: '2026-09-15T00:00:00.000Z',
          items: [
            {
              action: 'confirm_content',
              count: 1,
              detail: '识别结果需要确认后才能批改。',
              estimatedMinutes: 2,
              explanation: '内容确认会阻塞后续批改和学习，先处理最早的一项。',
              id: 'today:content:job-1',
              isOptional: false,
              kind: 'content_confirmation',
              priority: 1,
              remainingCount: 0,
              sourceTraces: [],
              targetIds: ['job-1'],
              title: '先确认识别内容',
            },
            {
              action: 'start_review',
              count: 5,
              detail: '5 张卡已经到期。',
              estimatedMinutes: 5,
              explanation: '到期复习组成一次约 5 分钟的短复习。',
              id: 'today:review:card-1',
              isOptional: true,
              kind: 'due_review',
              priority: 4,
              remainingCount: 2,
              sourceTraces: [],
              targetIds: ['card-1', 'card-2', 'card-3', 'card-4', 'card-5'],
              title: '完成今日短复习',
            },
          ],
          learnerProfileId: 'profile-1',
          noPenaltyMessage: '跳过或稍后完成不会扣分、扣 XP 或中断连续学习。',
          policyVersion: 'today-route-v1',
        })}
        onStartCapture={onStartCapture}
        onStartReview={onStartReview}
      />,
    );

    expect(await view.findByText('今天有 2 个小步骤')).toBeVisible();
    expect(view.getByText(/内容确认会阻塞后续批改和学习/)).toBeVisible();
    expect(view.getByText(/本次 5 项 · 另有 2 项稍后安排/)).toBeVisible();
    expect(view.getByText(/跳过或稍后完成不会扣分/)).toBeVisible();
    await fireEvent.press(view.getByRole('button', { name: '开始：先确认识别内容' }));
    await fireEvent.press(view.getByRole('button', { name: '开始：完成今日短复习' }));
    expect(onStartCapture).toHaveBeenCalledTimes(1);
    expect(onStartReview).toHaveBeenCalledTimes(1);
  });
});
