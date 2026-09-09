import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';

import { DEPENDENCY_PROBES, type DependencyProbe } from './dependency-probe.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DEPENDENCY_PROBES)
    private readonly dependencyProbes: DependencyProbe[],
  ) {}

  @Get('live')
  getLiveness() {
    return { status: 'alive' } as const;
  }

  @Get('ready')
  async getReadiness() {
    const checks = await Promise.all(
      this.dependencyProbes.map(async (probe) => {
        try {
          await probe.check();
          return [probe.name, 'ready'] as const;
        } catch {
          return [probe.name, 'unavailable'] as const;
        }
      }),
    );
    const dependencies = Object.fromEntries(checks);
    const isReady = checks.every(([, status]) => status === 'ready');
    const body = {
      dependencies,
      status: isReady ? 'ready' : 'not_ready',
    } as const;

    if (!isReady) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
