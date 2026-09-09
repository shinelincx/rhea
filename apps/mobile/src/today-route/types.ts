export interface TodayRoute {
  generatedAt: string;
  items: TodayRouteItem[];
  learnerProfileId: string | null;
}

export interface TodayRouteItem {
  id: string;
  title: string;
}

export type LoadTodayRoute = () => Promise<TodayRoute>;
