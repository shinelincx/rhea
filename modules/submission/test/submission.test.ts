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
  type RecognitionPort,
  type UploadPageInput,
} from '../src/index.js';

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

function setup(recognition: RecognitionPort = deterministicRecognition) {
  const objectStore = new MemoryObjectStore();
  const rawAssetDeletions = new MemoryRawAssetDeletionLog();
  const service = new SubmissionService({
    fileInspection: deterministicFileInspection,
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
    const { objectStore, rawAssetDeletions, service } = setup();
    const first = jpeg();
    const upload = await uploaded(service, first);
    const job = await service.submit({
      learningProfileId: 'profile-1',
      uploadSessionId: upload.id,
    });

    expect(job.status).toBe('queued');
    const recognized = await service.process(job.id, 'profile-1');
    expect(recognized.status).toBe('awaiting_confirmation');
    expect(recognized.candidate?.adapterVersion).toBe('deterministic-ocr-v1');
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
    release({ adapterVersion: 'late-ocr-v1', regions: [] });
    const final = await processing;

    expect(final).toMatchObject({ candidate: null, status: 'canceled' });
  });
});
