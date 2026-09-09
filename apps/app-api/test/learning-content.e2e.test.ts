import { createHash } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
import { LearningContentService, MemoryLearningContentStore } from '@rhea/learning-content';
import {
  MemoryObjectStore,
  MemoryRawAssetDeletionLog,
  MemorySubmissionStore,
  SubmissionService,
  deterministicFileInspection,
  deterministicRecognition,
  type ProcessingJobView,
} from '@rhea/submission';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app.js';

describe('Learning content HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => app?.close());

  it('organizes confirmed content, preserves corrections, and selects among conflicting sources', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'content-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '学习内容测试家庭',
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
    const learner = await familyAccess.issueLearnerSession({
      deviceAccessToken: device.accessToken,
      learningProfileId: profile.id,
      pin: '2468',
    });
    await familyAccess.reverifyGuardian({
      accessToken: guardian.accessToken,
      identityAssertion: 'content-guardian',
    });
    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      granted: true,
      kind: 'photo_processing',
    });
    const submissions = new SubmissionService({
      fileInspection: deterministicFileInspection,
      objectStore: new MemoryObjectStore(),
      rawAssetDeletions: new MemoryRawAssetDeletionLog(),
      recognition: deterministicRecognition,
      store: new MemorySubmissionStore(),
    });
    const scheduled: ProcessingJobView[] = [];
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      learningContentService: new LearningContentService({
        store: new MemoryLearningContentStore(),
      }),
      submissionScheduler: { schedule: (job) => scheduled.push(job) },
      submissionService: submissions,
    });
    await app.init();

    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const page = {
      crop: null,
      fileName: '待归类.jpg',
      height: 1_600,
      id: 'page-1',
      mimeType: 'image/jpeg',
      order: 0,
      rotation: 0,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      width: 1_200,
    };
    const createdUpload = await app.inject({
      headers: {
        authorization: `Bearer ${learner.accessToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      payload: { pages: [page] },
      url: '/v1/upload-sessions',
    });
    const upload = createdUpload.json<{
      data: { id: string; pages: Array<{ id: string; url: string }> };
    }>().data;
    await app.inject({
      headers: { 'content-type': 'image/jpeg' },
      method: 'PUT',
      payload: bytes,
      url: upload.pages[0]!.url,
    });
    const submitted = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: { uploadSessionId: upload.id },
      url: '/v1/submissions',
    });
    const job = submitted.json<{ data: ProcessingJobView }>().data;
    await submissions.process(job.id, profile.id);
    await submissions.confirm({ edits: {}, id: job.id, learningProfileId: profile.id });

    const baseUrl = `/v1/family-spaces/${family.id}/learning-profiles/${profile.id}`;
    const organizedResponse = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: {
        classification: {
          coursePathName: null,
          knowledgePointNames: [],
          primaryKnowledgePointName: null,
          primarySubject: null,
          relatedSubjects: [],
          unitName: null,
        },
        processingJobId: job.id,
      },
      url: `${baseUrl}/learning-materials`,
    });
    expect(organizedResponse.statusCode).toBe(201);
    const organized = organizedResponse.json<{
      data: { id: string; sourceVersions: Array<{ id: string }> };
    }>().data;
    expect(organizedResponse.json()).toMatchObject({
      data: { currentClassification: { status: 'pending' } },
    });

    const corrected = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'PUT',
      payload: {
        classification: {
          coursePathName: '沪教版三年级上册',
          knowledgePointNames: ['两位数乘法'],
          primaryKnowledgePointName: '两位数乘法',
          primarySubject: 'mathematics',
          relatedSubjects: [],
          unitName: '乘法',
        },
        reason: '按教材目录归类',
      },
      url: `${baseUrl}/learning-materials/${organized.id}/classification`,
    });
    expect(corrected.json()).toMatchObject({
      data: {
        classificationHistory: [
          { revision: 1, status: 'pending' },
          { changedBy: { type: 'guardian' }, primarySubject: 'mathematics', revision: 2 },
        ],
      },
    });

    const firstAnswerResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: {
        contentHash: 'b'.repeat(64),
        kind: 'answer',
        label: '教师答案',
        versionLabel: '第 1 版',
      },
      url: `${baseUrl}/learning-materials/${organized.id}/source-versions`,
    });
    expect(firstAnswerResponse.json()).toMatchObject({ data: { basis: { hasConflict: false } } });
    const withAnswerResponse = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'POST',
      payload: {
        contentHash: 'c'.repeat(64),
        kind: 'answer',
        label: '教师修订答案',
        versionLabel: '第 2 版',
      },
      url: `${baseUrl}/learning-materials/${organized.id}/source-versions`,
    });
    const withAnswer = withAnswerResponse.json<{
      data: { sourceVersions: Array<{ id: string }> };
    }>().data;
    const answerId = withAnswer.sourceVersions.at(-1)!.id;
    expect(withAnswerResponse.json()).toMatchObject({ data: { basis: { hasConflict: true } } });

    const selected = await app.inject({
      headers: { authorization: `Bearer ${guardian.accessToken}` },
      method: 'PUT',
      payload: { reason: '采用教师答案', sourceVersionId: answerId },
      url: `${baseUrl}/learning-materials/${organized.id}/current-basis`,
    });
    expect(selected.json()).toMatchObject({
      data: {
        basis: { currentSourceVersionId: answerId, hasConflict: true, selectionRevision: 2 },
      },
    });
    const basisReference = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `${baseUrl}/learning-materials/${organized.id}/current-basis-reference`,
    });
    expect(basisReference.json()).toMatchObject({
      data: {
        contentHash: 'c'.repeat(64),
        materialId: organized.id,
        selectionVersion: 2,
        sourceVersionId: answerId,
      },
    });
  });
});
