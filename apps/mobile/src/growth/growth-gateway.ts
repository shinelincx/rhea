export interface MobileGrowthView {
  badges: Array<{ description: string; key: string; label: string }>;
  components: Array<{
    contribution: number;
    earnedUnits: number;
    explanation: string;
    maximumContribution: number;
    name: string;
    weight: number;
  }>;
  growthScore: number;
  level: number;
  nextLevelAtXp: number;
  policy: {
    learningAccess: 'always_available';
    personalInformationRequired: false;
    purchaseRequired: false;
    ranking: 'none';
    speedAffectsScore: false;
  };
  streak: { bestDays: number; currentDays: number; message: string };
  xp: number;
}

export interface GrowthGateway {
  getGrowth(input: {
    accessToken: string;
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<MobileGrowthView>;
}

export function createGrowthGateway(apiBaseUrl: string): GrowthGateway {
  return {
    async getGrowth(input) {
      const response = await fetch(
        `${apiBaseUrl}/v1/family-spaces/${encodeURIComponent(input.familySpaceId)}/learning-profiles/${encodeURIComponent(input.learningProfileId)}/growth`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      );
      if (!response.ok) throw new Error('成长记录暂时没有加载出来');
      const body = (await response.json()) as { data?: MobileGrowthView };
      if (
        !body.data ||
        typeof body.data.growthScore !== 'number' ||
        !Array.isArray(body.data.components)
      ) {
        throw new Error('成长记录格式无效');
      }
      return body.data;
    },
  };
}
