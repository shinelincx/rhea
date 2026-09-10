import { createHash } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createInMemoryFamilyAccess } from '@rhea/family-access';
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
import { createLocalCapabilityAuthorization } from '../src/quality-control/local-capability-authorization.js';
import { LOCAL_RECOGNITION_CAPABILITY } from '../src/submission/create-local-submission.js';

describe('Submission HTTP interface', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('keeps OCR behind learner authorization and photo-processing consent', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'submission-guardian' });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '识别测试家庭',
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
    const service = new SubmissionService({
      capabilityAuthorization: createLocalCapabilityAuthorization(LOCAL_RECOGNITION_CAPABILITY),
      fileInspection: deterministicFileInspection,
      objectStore: new MemoryObjectStore(),
      rawAssetDeletions: new MemoryRawAssetDeletionLog(),
      recognition: deterministicRecognition,
      store: new MemorySubmissionStore(),
    });
    const scheduled: Array<{ job: ProcessingJobView; learningProfileId: string }> = [];
    app = await createApp({
      dependencyProbes: [],
      familyAccess,
      submissionScheduler: {
        schedule: (job, learningProfileId) => scheduled.push({ job, learningProfileId }),
      },
      submissionService: service,
    });
    await app.init();

    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const page = {
      crop: null,
      fileName: '作业.jpg',
      height: 1_600,
      id: 'page-1',
      mimeType: 'image/jpeg',
      order: 0,
      rotation: 0,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      width: 1_200,
    };
    const blocked = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: { pages: [page] },
      url: '/v1/upload-sessions',
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: 'CONSENT_REQUIRED' } });

    await familyAccess.reverifyGuardian({
      accessToken: guardian.accessToken,
      identityAssertion: 'submission-guardian',
    });
    await familyAccess.changeConsent({
      accessToken: guardian.accessToken,
      familySpaceId: family.id,
      granted: true,
      kind: 'photo_processing',
    });
    const created = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: { pages: [page] },
      url: '/v1/upload-sessions',
    });
    expect(created.statusCode).toBe(201);
    const upload = created.json<{
      data: { id: string; pages: Array<{ id: string; url: string }> };
    }>().data;
    const uploaded = await app.inject({
      headers: { 'content-type': 'image/jpeg' },
      method: 'PUT',
      payload: bytes,
      url: upload.pages[0]!.url,
    });
    expect(uploaded.statusCode).toBe(204);

    const submitted = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'POST',
      payload: { uploadSessionId: upload.id },
      url: '/v1/submissions',
    });
    expect(submitted.statusCode).toBe(202);
    expect(scheduled).toHaveLength(1);
    const job = submitted.json<{ data: ProcessingJobView }>().data;
    await service.process(job.id, profile.id);

    const recognized = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'GET',
      url: `/v1/processing-jobs/${job.id}`,
    });
    expect(recognized.json()).toMatchObject({
      data: {
        candidate: {
          regions: expect.arrayContaining([
            expect.objectContaining({ confidence: 0.97, lowConfidence: false }),
          ]),
        },
        status: 'awaiting_confirmation',
      },
    });

    const candidate = recognized.json<{ data: ProcessingJobView }>().data.candidate!;
    const confirmed = await app.inject({
      headers: { authorization: `Bearer ${learner.accessToken}` },
      method: 'PUT',
      payload: { edits: { [candidate.regions[1]!.id]: '9' } },
      url: `/v1/content-confirmations/${job.id}`,
    });
    expect(confirmed.json()).toMatchObject({
      data: {
        completedContent: {
          sourceCandidateId: candidate.id,
          sourceHash: candidate.sourceHash,
        },
        status: 'completed',
      },
    });
  });
});
