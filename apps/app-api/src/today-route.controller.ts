import { Controller, Get } from '@nestjs/common';

@Controller('v1/today-route')
export class TodayRouteController {
  @Get()
  getTodayRoute() {
    return {
      data: {
        generatedAt: new Date().toISOString(),
        items: [],
        learnerProfileId: null,
      },
    };
  }
}
