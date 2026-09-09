import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { JOB_CLIENT, type JobClient } from './job-client.js';

interface ProbeJobBody {
  outcome?: unknown;
}

@Controller('internal/probe-jobs')
export class ProbeJobsController {
  constructor(@Inject(JOB_CLIENT) private readonly jobClient: JobClient) {}

  @Post()
  @HttpCode(202)
  async submit(@Body() body: ProbeJobBody) {
    if (body.outcome !== 'success' && body.outcome !== 'failure') {
      throw new BadRequestException('outcome must be success or failure');
    }

    return {
      data: await this.jobClient.submit({
        kind: 'system.probe',
        payload: { outcome: body.outcome },
      }),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const job = await this.jobClient.get(id);
    if (!job) {
      throw new NotFoundException('probe job not found');
    }

    return { data: job };
  }
}
