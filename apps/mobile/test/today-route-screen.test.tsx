import { render } from '@testing-library/react-native';

import { TodayRouteScreen } from '../src/today-route/TodayRouteScreen';

describe('Today route mobile interface', () => {
  it('shows the empty route returned by the backend', async () => {
    const view = await render(
      <TodayRouteScreen
        loadRoute={async () => ({
          generatedAt: '2026-09-09T00:00:00.000Z',
          items: [],
          learnerProfileId: null,
        })}
      />,
    );

    expect(await view.findByText('今天没有待办')).toBeVisible();
    expect(view.getByText('想学习时，拍一页练习就能开始。')).toBeVisible();
  });
});
