import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AssessmentService, MemoryAssessmentStore } from '@rhea/assessment';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { LearningContentService, MemoryLearningContentStore } from '@rhea/learning-content';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('Objective assessment HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => app?.close());

  it('grades, pauses a disputed result, and exposes the immutable regrade history', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'assessment-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '批改测试家庭',
    });
    const profile = await familyAccess.createLearningProfile({
      accessToken: guardian.accessToken,
      displayName: '小禾',
      familySpaceId: family.id,
      grade: 3,
      pin: '2468',
    });
    const device = await familyAccess.registerDevice({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      label: '测试设备',
    });
    const learnerSession = await familyAccess.issueLearnerSession({
      deviceAccessToken: device.accessToken,
      learningProfileId: profile.id,
      pin: '2468',
    });
    const learningContent = new LearningContentService({ store: new MemoryLearningContentStore() });
    const material = await learningContent.organizeConfirmedContent({
      actor: { id: profile.id, type: 'learner' },
      classification: {
        coursePathName: '沪教版三年级上册',
        knowledgePointNames: ['乘法'],
        primaryKnowledgePointName: '乘法',
        primarySubject: 'mathematics',
        relatedSubjects: [],
        unitName: '乘法',
      },
      confirmedContentVersion: 1,
      confirmedContentVersionId: '00000000-0000-4000-8000-000000000100',
      familySpaceId: family.id,
      learningProfileId: profile.id,
      sourceHash: 'a'.repeat(64),
    });
    const assessment = new AssessmentService({
      basisReader: learningContent,
      store: new MemoryAssessmentStore(),
    });
    app = await createApp({
      assessmentService: assessment,
      dependencyProbes: [],
      familyAccess,
      learningContentService: learningContent,
    });
    await app.init();

    const baseUrl = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}`;
    const gradedResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'POST',
      payload: {
        materialId: material.id,
        question: {
          contentHash: 'b'.repeat(64),
          subject: 'mathematics',
          text: '6 × 7 = ?',
          versionId: '00000000-0000-4000-8000-000000000101',
        },
        response: {
          contentHash: 'c'.repeat(64),
          text: '41',
          versionId: '00000000-0000-4000-8000-000000000102',
        },
        rule: { expected: '42', kind: 'numeric' },
      },
      url: `${baseUrl}/objective-assessments`,
    });
    expect(gradedResponse.statusCode).toBe(201);
    const graded = gradedResponse.json<{ data: { currentVersion: { id: string }; id: string } }>()
      .data;

    const disputedResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'POST',
      payload: {
        correctionText: '识别出的作答少了一笔，我写的是 42。',
        reason: '作答识别错误',
        target: 'response',
      },
      url: `${baseUrl}/objective-assessments/${graded.id}/disputes`,
    });
    expect(disputedResponse.statusCode).toBe(201);
    const disputed = disputedResponse.json<{ data: { openDisputeId: string } }>().data;

    const paused = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/objective-assessments/${graded.id}/downstream-reference`,
    });
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toMatchObject({ error: { code: 'DOWNSTREAM_INELIGIBLE' } });

    const resolvedResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: {
        correctedResponse: {
          contentHash: 'd'.repeat(64),
          text: '42',
          versionId: '00000000-0000-4000-8000-000000000103',
        },
        reason: '监护人核对原稿后修正',
      },
      url: `${baseUrl}/objective-assessments/${graded.id}/disputes/${disputed.openDisputeId}/resolution`,
    });
    expect(resolvedResponse.statusCode).toBe(201);
    expect(resolvedResponse.json()).toMatchObject({
      data: {
        currentVersion: {
          decision: { outcome: 'correct' },
          predecessorId: graded.currentVersion.id,
          revision: 2,
        },
        openDisputeId: null,
        versions: [{ revision: 1 }, { revision: 2 }],
      },
    });
  });
});
