export interface TodayRoute {
  generatedAt: string;
  items: TodayRouteItem[];
  learnerProfileId: string;
  noPenaltyMessage: string;
  policyVersion: 'today-route-v1';
}

export interface TodayRouteItem {
  action:
    | 'confirm_content'
    | 'correct_wrong_item'
    | 'resume_learning'
    | 'review_result'
    | 'start_challenge'
    | 'start_review'
    | 'start_variation';
  count: number;
  detail: string;
  estimatedMinutes: number;
  explanation: string;
  id: string;
  isOptional: boolean;
  kind:
    | 'challenge'
    | 'content_confirmation'
    | 'due_review'
    | 'result_review'
    | 'resume_learning'
    | 'variation_practice'
    | 'wrong_item_correction';
  priority: number;
  remainingCount: number;
  sourceTraces: unknown[];
  targetIds: string[];
  title: string;
}

export type LoadTodayRoute = () => Promise<TodayRoute>;

export interface TodayRouteRequest {
  accessToken: string;
  familySpaceId: string;
  learningProfileId: string;
}

export type FetchTodayRoute = (input: TodayRouteRequest) => Promise<TodayRoute>;
