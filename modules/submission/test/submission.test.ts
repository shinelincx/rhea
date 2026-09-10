import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MemoryObjectStore,
  MemoryRawAssetDeletionLog,
  MemorySubmissionStore,
  SubmissionError,
  SubmissionService,
  deterministicFileInspection,
  deterministicRecognition,
  deterministicRecognitionCapability,
  type RecognitionCapabilityAuthorizationPort,
  type RecognitionPort,
  type UploadPageInput,
} from '../src/index.js';

const OCR_CAPABILITY = deterministicRecognitionCapability;

const AUTHORIZATION_DECISION_ID = '22222222-2222-4222-8222-222222222222';
const AUTHORIZATION_EPOCH = 7;

const approvedCapabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
  async authorizeCapability(input) {
    return {
      containmentEpoch: AUTHORIZATION_EPOCH,
      decisionId: AUTHORIZATION_DECISION_ID,
      degradedReason: null,
      issuedAt: '2026-09-10T10:14:59.000Z',
      primary: { capabilityVersion: OCR_CAPABILITY, rolloutStage: 'general' },
      rolloutBucket: 321,
      scope: input,
      shadow: null,
      status: 'authorized',
    };
  },
  async revalidateAuthorization(input) {
    return {
      capabilityVersion: OCR_CAPABILITY,
      containmentEpoch: input.expectedContainmentEpoch,
      decisionId: input.decisionId,
      status: 'authorized',
    };
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jpeg(marker = ''): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(marker)]);
}

function page(bytes: Uint8Array, overrides: Partial<UploadPageInput> = {}): UploadPageInput {
  return {
    crop: null,
    fileName: '数学练习.jpg',
    height: 1600,
    id: 'page-1',
    mimeType: 'image/jpeg',
    order: 0,
    rotation: 0,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    width: 1200,
    ...overrides,
  };
}

function setup(
  recognition: RecognitionPort = deterministicRecognition,
  clock?: { readonly now: Date },
  capabilityAuthorization: RecognitionCapabilityAuthorizationPort = approvedCapabilityAuthorization,
) {
  const objectStore = new MemoryObjectStore();
  const rawAssetDeletions = new MemoryRawAssetDeletionLog();
  const service = new SubmissionService({
    fileInspection: deterministicFileInspection,
    ...(clock ? { clock } : {}),
    capabilityAuthorization,
    objectStore,
    rawAssetDeletions,
    recognition,
    store: new MemorySubmissionStore(),
  });
  return { objectStore, rawAssetDeletions, service };
}

async function uploaded(service: SubmissionService, bytes: Uint8Array) {
  const upload = await service.createUploadSession({
    familySpaceId: 'family-1',
    learningProfileId: 'profile-1',
    pages: [page(bytes)],
  });
  await service.uploadPage({
    bytes,
    learningProfileId: 'profile-1',
    pageId: 'page-1',
    token: upload.pages[0]!.uploadToken,
    uploadSessionId: upload.id,
  });
  return upload;
}

describe('submission recognition workflow', () => {
  it('uploads exact bytes, recognizes deterministically, highlights uncertainty, and confirms edits', async () => {
    const { objectStore, rawAssetDeletions, service } = setup(deterministicRecognition, {
      now: new Date('2026-09-10T10:15:00.000Z'),
    });
    const first = jpeg();
    const upload = await uploaded(service, first);
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    expect(job.status).toBe('queued');
    const recognized = await service.process(job.id, 'profile-1');
    expect(recognized.status).toBe('awaiting_confirmation');
    expect(recognized.candidate?.finishedAt).toBe('2026-09-10T10:15:00.000Z');
    expect(recognized.candidate?.adapterVersion).toBe('deterministic-ocr-v1');
    expect(recognized.candidate?.authorization).toEqual({
      capabilityVersion: OCR_CAPABILITY,
      containmentEpoch: AUTHORIZATION_EPOCH,
      decisionId: AUTHORIZATION_DECISION_ID,
      status: 'authorized',
    });
    expect(recognized.candidate?.regions[0]).toMatchObject({ lowConfidence: false });
    expect(recognized.candidate?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'page-1:answer',
          questionRegionId: 'page-1:question',
        }),
      ]),
    );

    const confirmed = await service.confirm({
      edits: { 'page-1:answer': '9' },
      id: job.id,
      learningProfileId: 'profile-1',
    });
    expect(confirmed.status).toBe('completed');
    expect(confirmed.completedContent).toMatchObject({
      confirmedByLearningProfileId: 'profile-1',
      sourceCandidateId: recognized.candidate?.id,
      regions: expect.arrayContaining([expect.objectContaining({ text: '9' })]),
    });
    expect(objectStore.objects.size).toBe(0);
    expect(rawAssetDeletions.receipts).toHaveLength(1);
  });

  it('reports backend quality issues before confirmation', async () => {
    const { service } = setup();
    const bytes = jpeg('RHEA_TOO_DARK RHEA_GLARE RHEA_MISSING_EDGE');
    const upload = await service.createUploadSession({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      pages: [page(bytes, { height: 600, width: 800 })],
    });
    await service.uploadPage({
      bytes,
      learningProfileId: 'profile-1',
      pageId: 'page-1',
      token: upload.pages[0]!.uploadToken,
      uploadSessionId: upload.id,
    });
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });
    const recognized = await service.process(job.id, 'profile-1');
    expect(recognized.qualityIssues.map(({ issue }) => issue)).toEqual([
      'blurry',
      'too_dark',
      'glare',
      'missing_edge',
    ]);
  });

  it('degrades recoverably without calling OCR when no capability is authorized', async () => {
    let recognitionCalls = 0;
    const recognition: RecognitionPort = {
      async recognize() {
        recognitionCalls += 1;
        return { regions: [] };
      },
    };
    const capabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
      async authorizeCapability(input) {
        return {
          containmentEpoch: AUTHORIZATION_EPOCH,
          decisionId: AUTHORIZATION_DECISION_ID,
          degradedReason: 'NO_SIGNED_CAPABILITY',
          issuedAt: '2026-09-10T10:14:59.000Z',
          primary: null,
          rolloutBucket: 321,
          scope: input,
          shadow: null,
          status: 'degraded',
        };
      },
      async revalidateAuthorization() {
        throw new Error('A degraded decision must not be revalidated');
      },
    };
    const { service } = setup(recognition, undefined, capabilityAuthorization);
    const upload = await uploaded(service, jpeg());
    const queued = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    const unavailable = await service.process(queued.id, 'profile-1');

    expect(unavailable).toMatchObject({
      candidate: null,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      nextAction: 'retry',
      retryable: true,
      status: 'unavailable',
    });
    expect(recognitionCalls).toBe(0);
  });

  it('rejects a forged upload and keeps the upload session recoverable', async () => {
    const { service } = setup();
    const bytes = jpeg();
    const upload = await service.createUploadSession({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      pages: [page(bytes)],
    });
    await expect(
      service.uploadPage({
        bytes,
        learningProfileId: 'profile-1',
        pageId: 'page-1',
        token: 'forged',
        uploadSessionId: upload.id,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOKEN_INVALID' });
    await expect(
      service.submit({ learningProfileId: 'profile-1', uploadSessionId: upload.id }),
    ).rejects.toEqual(expect.any(SubmissionError));
  });

  it('does not publish an OCR result that arrives after cancellation', async () => {
    let release!: (value: Awaited<ReturnType<RecognitionPort['recognize']>>) => void;
    const recognition: RecognitionPort = {
      recognize: () => new Promise((resolve) => (release = resolve)),
    };
    const { service } = setup(recognition);
    const upload = await uploaded(service, jpeg());
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });
    const processing = service.process(job.id, 'profile-1');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.cancel({ id: job.id, learningProfileId: 'profile-1' })).status).toBe(
      'canceled',
    );
    release({ regions: [] });
    const final = await processing;

    expect(final).toMatchObject({ candidate: null, status: 'canceled' });
  });

  it('does not persist a returned OCR result after its authorization epoch becomes stale', async () => {
    let recognitionCalls = 0;
    const recognition: RecognitionPort = {
      async recognize() {
        recognitionCalls += 1;
        return { regions: [] };
      },
    };
    const capabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
      authorizeCapability: approvedCapabilityAuthorization.authorizeCapability,
      async revalidateAuthorization(input) {
        if (input.phase === 'before_send') {
          return approvedCapabilityAuthorization.revalidateAuthorization(input);
        }
        return {
          containmentEpoch: AUTHORIZATION_EPOCH + 1,
          decisionId: input.decisionId,
          reason: 'AUTHORIZATION_STALE',
          status: 'rejected',
        };
      },
    };
    const { service } = setup(recognition, undefined, capabilityAuthorization);
    const upload = await uploaded(service, jpeg());
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    const result = await service.process(job.id, 'profile-1');

    expect(result).toMatchObject({
      candidate: null,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      nextAction: 'retry',
      retryable: true,
      status: 'unavailable',
    });
    expect(recognitionCalls).toBe(1);
    expect(await service.getJob({ id: job.id, learningProfileId: 'profile-1' })).toMatchObject({
      candidate: null,
      status: 'unavailable',
    });
  });

  it('discards an OCR response rejected during after-receive authorization', async () => {
    const capabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
      authorizeCapability: approvedCapabilityAuthorization.authorizeCapability,
      async revalidateAuthorization(input) {
        if (input.phase === 'after_receive') {
          return {
            containmentEpoch: AUTHORIZATION_EPOCH + 1,
            decisionId: input.decisionId,
            reason: 'CAPABILITY_CONTAINED',
            status: 'rejected',
          };
        }
        return approvedCapabilityAuthorization.revalidateAuthorization(input);
      },
    };
    const { service } = setup(deterministicRecognition, undefined, capabilityAuthorization);
    const upload = await uploaded(service, jpeg());
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    expect(await service.process(job.id, 'profile-1')).toMatchObject({
      candidate: null,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      status: 'unavailable',
    });
  });

  it('does not call OCR when containment invalidates authorization before sending', async () => {
    let recognitionCalls = 0;
    const recognition: RecognitionPort = {
      async recognize() {
        recognitionCalls += 1;
        return { regions: [] };
      },
    };
    const capabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
      authorizeCapability: approvedCapabilityAuthorization.authorizeCapability,
      async revalidateAuthorization(input) {
        return {
          containmentEpoch: AUTHORIZATION_EPOCH + 1,
          decisionId: input.decisionId,
          reason: 'CAPABILITY_CONTAINED',
          status: 'rejected',
        };
      },
    };
    const { service } = setup(recognition, undefined, capabilityAuthorization);
    const upload = await uploaded(service, jpeg());
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    const result = await service.process(job.id, 'profile-1');

    expect(result).toMatchObject({
      candidate: null,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      retryable: true,
      status: 'unavailable',
    });
    expect(recognitionCalls).toBe(0);
  });

  it('retries the retained submission after an OCR capability becomes available', async () => {
    let available = false;
    let recognitionCalls = 0;
    const recognition: RecognitionPort = {
      async recognize() {
        recognitionCalls += 1;
        return { regions: [] };
      },
    };
    const capabilityAuthorization: RecognitionCapabilityAuthorizationPort = {
      async authorizeCapability(input) {
        if (available) {
          return approvedCapabilityAuthorization.authorizeCapability(input);
        }
        return {
          containmentEpoch: AUTHORIZATION_EPOCH,
          decisionId: AUTHORIZATION_DECISION_ID,
          degradedReason: 'NO_APPLICABLE_CAPABILITY',
          issuedAt: '2026-09-10T10:14:59.000Z',
          primary: null,
          rolloutBucket: 321,
          scope: input,
          shadow: null,
          status: 'degraded',
        };
      },
      revalidateAuthorization: approvedCapabilityAuthorization.revalidateAuthorization,
    };
    const { service } = setup(recognition, undefined, capabilityAuthorization);
    const upload = await uploaded(service, jpeg());
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    expect((await service.process(job.id, 'profile-1')).status).toBe('unavailable');
    expect(recognitionCalls).toBe(0);
    available = true;

    expect(await service.process(job.id, 'profile-1')).toMatchObject({
      candidate: { authorization: { capabilityVersion: OCR_CAPABILITY } },
      errorCode: null,
      retryable: false,
      status: 'awaiting_confirmation',
    });
    expect(recognitionCalls).toBe(1);
  });
});
