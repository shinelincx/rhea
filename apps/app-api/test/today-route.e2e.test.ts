import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { MemoryReportingStore, ReportingService, type ReportingSourceTrace } from '@rhea/reporting';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

function source(id: string): ReportingSourceTrace {
  return {
    aggregateId: id,
    aggregateType: 'processing_job',
    authorityState: 'pending',
    history: [],
    sourceVersions: { revision: 1 },
  };
}

async function familyFixture() {
  const familyAccess = createInMemoryFamilyAccess();
  const guardian = await familyAccess.loginGuardian({ identityAssertion: 'reporting-guardian' });
  const family = await familyAccess.createFamilySpace({
    accessToken: guardian.accessToken,
    name: '报告测试家庭',
  });
  const profile = await familyAccess.createLearningProfile({
    accessToken: guardian.accessToken,
    displayName: '小禾',
    familySpaceId: family.id,
    grade: 4,
    pin: '2468',
  });
  const device = await familyAccess.registerDevice({
    accessToken: guardian.accessToken,
    familySpaceId: family.id,
    label: '家庭平板',
  });
  const learner = await familyAccess.issueLearnerSession({
    deviceAccessToken: device.accessToken,
    learningProfileId: profile.id,
    pin: '2468',
  });
  return { family, familyAccess, guardian, learner, profile };
}

describe('Reporting HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('returns an authenticated, explainable learner route', async () => {
    const fixture = await familyFixture();
    const reporting = new ReportingService({
      clock: { now: new Date('2026-09-15T00:00:00.000Z') },
      store: new MemoryReportingStore({
        routeCandidates: [
          {
            actionTargetId: 'job-1',
            createdAt: '2026-09-14T00:00:00.000Z',
            current: true,
            detail: '识别结果需要确认后才能批改。',
            dueAt: null,
            id: 'job-1',
            kind: 'content_confirmation',
            source: source('job-1'),
            title: '确认识别内容',
          },
        ],
      }),
    });
    app = await createApp({
      dependencyProbes: [],
      familyAccess: fixture.familyAccess,
      reportingService: reporting,
    });
    await app.init();

    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.learner.accessToken}` },
      method: 'GET',
      url: `/v1/family-spaces/${fixture.family.id}/learning-profiles/${fixture.profile.id}/today-route`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        items: [
          {
            action: 'confirm_content',
            explanation: expect.any(String),
            kind: 'content_confirmation',
            targetIds: ['job-1'],
          },
        ],
        learnerProfileId: fixture.profile.id,
        noPenaltyMessage: expect.stringContaining('不会扣分'),
        policyVersion: 'today-route-v1',
      },
    });
  });

  it('keeps the guardian report out of learner sessions and exposes traceable exclusions', async () => {
    const fixture = await familyFixture();
    const reporting = new ReportingService({
      clock: { now: new Date('2026-09-15T00:00:00.000Z') },
      store: new MemoryReportingStore({
        exclusions: [
          {
            id: 'pending-suggestion',
            reason: '开放题建议尚未接受',
            source: {
              ...source('pending-suggestion'),
              aggregateType: 'suggested_assessment',
            },
            subject: 'chinese',
          },
        ],
        guardianTodos: [
          {
            actionTargetId: 'pending-suggestion',
            createdAt: '2026-09-14T00:00:00.000Z',
            current: true,
            detail: '开放题建议尚未接受。',
            id: 'pending-suggestion',
            kind: 'open_assessment_review',
            source: source('pending-suggestion'),
            title: '复核开放题建议',
          },
        ],
      }),
    });
    app = await createApp({
      dependencyProbes: [],
      familyAccess: fixture.familyAccess,
      reportingService: reporting,
    });
    await app.init();
    const url = `/v1/family-spaces/${fixture.family.id}/learning-profiles/${fixture.profile.id}/guardian-report`;

    const learner = await app.inject({
      headers: { authorization: `Bearer ${fixture.learner.accessToken}` },
      method: 'GET',
      url,
    });
    expect(learner.statusCode).toBe(403);
    expect(learner.json()).toMatchObject({
      error: { code: 'GUARDIAN_REQUIRED', recovery: 'ENTER_GUARDIAN_MODE' },
    });

    const guardian = await app.inject({
      headers: { authorization: `Bearer ${fixture.guardian.accessToken}` },
      method: 'GET',
      url,
    });
    expect(guardian.statusCode).toBe(200);
    expect(guardian.json()).toMatchObject({
      data: {
        learnerProfileId: fixture.profile.id,
        learningReport: {
          excluded: { pending: 1 },
          policyVersion: 'learning-report-v1',
        },
        todos: {
          counts: { openAssessmentReview: 1, total: 1 },
          items: [{ action: 'review_assessment', kind: 'open_assessment_review' }],
        },
      },
    });
  });

  it('allows the configured mobile web origin without opening the API to every site', async () => {
    app = await createApp({
      allowedOrigins: ['http://127.0.0.1:8081'],
      dependencyProbes: [],
    });
    await app.init();

    const allowed = await app.inject({
      headers: {
        origin: 'http://127.0.0.1:8081',
        'access-control-request-method': 'GET',
      },
      method: 'OPTIONS',
      url: '/v1/family-spaces/family/learning-profiles/profile/today-route',
    });
    const denied = await app.inject({
      headers: {
        origin: 'https://untrusted.example',
        'access-control-request-method': 'GET',
      },
      method: 'OPTIONS',
      url: '/v1/family-spaces/family/learning-profiles/profile/today-route',
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8081');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the mobile client to end a session through a CORS preflight', async () => {
    app = await createApp({
      allowedOrigins: ['http://127.0.0.1:8081'],
      dependencyProbes: [],
    });
    await app.init();

    const response = await app.inject({
      headers: {
        origin: 'http://127.0.0.1:8081',
        'access-control-request-method': 'DELETE',
      },
      method: 'OPTIONS',
      url: '/v1/session',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
  });
});
