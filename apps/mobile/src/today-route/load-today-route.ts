import type { LoadTodayRoute, TodayRoute } from './types';

interface TodayRouteEnvelope {
  data: TodayRoute;
}

export function createTodayRouteLoader(baseUrl: string): LoadTodayRoute {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/today-route`;

  return async () => {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Today route request failed with ${response.status}`);
    }

    const envelope = (await response.json()) as TodayRouteEnvelope;
    return envelope.data;
  };
}
