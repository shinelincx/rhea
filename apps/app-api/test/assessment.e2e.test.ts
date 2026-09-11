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
      inputReader: {
        confirmObjectiveRule: async () => true,
        async resolveObjectiveInput({ reference }) {
          const answers: Record<string, string> = { 'answer-1': '41', 'answer-2': '42' };
          const responseText = answers[reference.responseRegionId];
          if (
            reference.confirmedContentVersionId !== '00000000-0000-4000-8000-000000000100' ||
            reference.processingJobId !== '00000000-0000-4000-8000-000000000104' ||
            reference.questionRegionId !== 'question-1' ||
            !responseText
          ) {
            return null;
          }
          return {
            gradingRuleVersionId: 'trusted-test-rule-v1',
            question: {
              subject: 'mathematics' as const,
              text: '6 × 7 = ?',
              versionId: `content-1:${reference.questionRegionId}`,
            },
            requiresProfessionalReview: false,
            response: {
              text: responseText,
              versionId: `content-1:${reference.responseRegionId}`,
            },
            rule: { expected: '42', kind: 'numeric' as const },
          };
        },
      },
      store: new MemoryAssessmentStore(),
    });
    app = await createApp({
      assessmentService: assessment,
      dependencyProbes: [],
      familyAccess,
      learningContentService: learningContent,
      professionalReviewAccess: {
        async authorize(input) {
          expect(input.authorization).toBe('Bearer professional-review-token');
          expect(input.familySpaceId).toBe(family.id);
          expect(input.learningProfileId).toBe(profile.id);
          return {
            id: '00000000-0000-4000-8000-000000000109',
            type: 'professional',
          };
        },
      },
    });
    await app.init();

    const baseUrl = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}`;
    const rulePayload = {
      inputReference: {
        confirmedContentVersionId: '00000000-0000-4000-8000-000000000100',
        processingJobId: '00000000-0000-4000-8000-000000000104',
        questionRegionId: 'question-1',
        responseRegionId: 'answer-1',
      },
      materialId: material.id,
      rule: { expected: '42', kind: 'numeric' },
    };
    const learnerConfirmation = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'POST',
      payload: rulePayload,
      url: `${baseUrl}/objective-grading-rules`,
    });
    expect(learnerConfirmation.statusCode).toBe(403);
    expect(learnerConfirmation.json()).toMatchObject({
      error: { code: 'RULE_CONFIRMATION_REQUIRES_GUARDIAN' },
    });
    const guardianConfirmation = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: rulePayload,
      url: `${baseUrl}/objective-grading-rules`,
    });
    expect(guardianConfirmation.statusCode).toBe(201);
    expect(guardianConfirmation.json()).toMatchObject({
      data: {
        confirmedBy: { type: 'guardian' },
        rule: { expected: '42', kind: 'numeric' },
      },
    });

    const gradedResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'POST',
      payload: {
        inputReference: {
          confirmedContentVersionId: '00000000-0000-4000-8000-000000000100',
          processingJobId: '00000000-0000-4000-8000-000000000104',
          questionRegionId: 'question-1',
          responseRegionId: 'answer-1',
        },
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
    const graded = gradedResponse.json<{
      data: {
        currentVersion: {
          decision: { expectedDisplay: string; outcome: string };
          id: string;
          question: { text: string };
          response: { text: string };
        };
        id: string;
      };
    }>().data;
    expect(graded.currentVersion).toMatchObject({
      decision: { expectedDisplay: '42', outcome: 'incorrect' },
      question: { text: '6 × 7 = ?' },
      response: { text: '41' },
    });

    const wrongItemLibraryResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/wrong-items?subject=mathematics&unitName=${encodeURIComponent('乘法')}&knowledgePointName=${encodeURIComponent('乘法')}`,
    });
    expect(wrongItemLibraryResponse.statusCode).toBe(200);
    const wrongItemLibrary = wrongItemLibraryResponse.json<{
      data: {
        items: Array<{
          assessment: { assessmentId: string; correctBasis: { expectedDisplay: string } };
          currentReason: { status: string };
          firstIncorrectAt: string;
          id: string;
          stateRevision: number;
          status: string;
        }>;
        themes: Array<{ itemCount: number; knowledgePointName: string }>;
      };
    }>().data;
    expect(wrongItemLibrary.items).toHaveLength(1);
    expect(wrongItemLibrary.items[0]).toMatchObject({
      assessment: {
        assessmentId: graded.id,
        correctBasis: { expectedDisplay: '42' },
      },
      currentReason: { status: 'suggested' },
      stateRevision: 1,
      status: 'pending_correction',
    });
    expect(wrongItemLibrary.items[0]?.firstIncorrectAt).toBeTruthy();
    expect(wrongItemLibrary.themes).toMatchObject([{ itemCount: 1, knowledgePointName: '乘法' }]);
    const wrongItemId = wrongItemLibrary.items[0]!.id;

    const confirmedReasonResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'POST',
      payload: { action: 'confirm', expectedStateRevision: 1 },
      url: `${baseUrl}/wrong-items/${wrongItemId}/reason-revisions`,
    });
    expect(confirmedReasonResponse.statusCode).toBe(201);
    expect(confirmedReasonResponse.json()).toMatchObject({
      data: { currentReason: { status: 'confirmed' }, stateRevision: 2 },
    });

    const correctedClassificationResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: {
        expectedStateRevision: 2,
        knowledgePointNames: ['表内乘法'],
        primaryKnowledgePointName: '表内乘法',
        subject: 'mathematics',
        unitName: '乘法基础',
      },
      url: `${baseUrl}/wrong-items/${wrongItemId}/classification-revisions`,
    });
    expect(correctedClassificationResponse.statusCode).toBe(201);
    expect(correctedClassificationResponse.json()).toMatchObject({
      data: {
        classification: {
          primaryKnowledgePointName: '表内乘法',
          revision: 2,
          status: 'classified',
          unitName: '乘法基础',
        },
        stateRevision: 3,
      },
    });

    const correctionRequest = {
      headers: {
        authorization: `Bearer ${learnerSession.accessToken}`,
        'idempotency-key': 'assessment-e2e-correction-1',
      },
      method: 'POST' as const,
      payload: { expectedStateRevision: 3, responseText: '42' },
      url: `${baseUrl}/wrong-items/${wrongItemId}/immediate-corrections`,
    };
    const correctionResponse = await app.inject(correctionRequest);
    expect(correctionResponse.statusCode).toBe(201);
    expect(correctionResponse.json()).toMatchObject({
      data: {
        correctionAttempts: [{ outcome: 'correct', responseText: '42' }],
        stateRevision: 4,
        status: 'pending_consolidation',
      },
    });
    const correctionRetryResponse = await app.inject(correctionRequest);
    expect(correctionRetryResponse.statusCode).toBe(201);
    expect(correctionRetryResponse.json()).toMatchObject({
      data: { correctionAttempts: [{ outcome: 'correct' }], stateRevision: 4 },
    });

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

    const hiddenDuringDisputeResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/wrong-items`,
    });
    expect(hiddenDuringDisputeResponse.statusCode).toBe(200);
    expect(hiddenDuringDisputeResponse.json()).toMatchObject({
      data: { items: [], themes: [] },
    });

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
        correction: { responseText: '42' },
        reason: '监护人核对原稿后修正',
      },
      url: `${baseUrl}/objective-assessments/${graded.id}/disputes/${disputed.openDisputeId}/resolution`,
    });
    expect(resolvedResponse.statusCode).toBe(201);
    expect(resolvedResponse.json()).toMatchObject({
      data: {
        currentVersion: {
          decision: { outcome: 'correct' },
          inputAuthority: { kind: 'guardian_correction' },
          predecessorId: graded.currentVersion.id,
          revision: 2,
        },
        openDisputeId: null,
        versions: [{ revision: 1 }, { revision: 2 }],
      },
    });

    const repeatedDisputeResponse = await app.inject({
      headers: { authorization: `Bearer ${learnerSession.accessToken}` },
      method: 'POST',
      payload: {
        correctionText: '采用答案仍需要专业核对。',
        reason: '重复质疑采用答案',
        target: 'assessment',
      },
      url: `${baseUrl}/objective-assessments/${graded.id}/disputes`,
    });
    expect(repeatedDisputeResponse.statusCode).toBe(201);
    const repeatedDispute = repeatedDisputeResponse.json<{
      data: { disputes: Array<{ reviewRoute: string }>; openDisputeId: string };
    }>().data;
    expect(repeatedDispute.disputes.at(-1)?.reviewRoute).toBe('professional');

    const professionalResolution = await app.inject({
      headers: { authorization: 'Bearer professional-review-token' },
      method: 'POST',
      payload: {
        correction: { rule: { expected: '43', kind: 'numeric' } },
        reason: '专业复核确认当前采用答案为 43',
        reviewCaseId: 'professional-review-case-1',
      },
      url: `/v1/professional-reviews/family-spaces/${family.id}/learning-profiles/${profile.id}/objective-assessments/${graded.id}/disputes/${repeatedDispute.openDisputeId}/resolution`,
    });
    expect(professionalResolution.statusCode).toBe(201);
    expect(professionalResolution.json()).toMatchObject({
      data: {
        currentVersion: {
          createdBy: {
            id: '00000000-0000-4000-8000-000000000109',
            type: 'professional',
          },
          inputAuthority: {
            kind: 'professional_review',
            reviewCaseId: 'professional-review-case-1',
          },
          revision: 3,
        },
        openDisputeId: null,
        resolutions: [
          { resolvedBy: { type: 'guardian' } },
          { resolvedBy: { type: 'professional' } },
        ],
      },
    });
  });
});
