import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { SubmissionError } from './error.js';
import type {
  FileInspectionPort,
  ObjectStorePort,
  RawAssetDeletionPort,
  RecognitionCapabilityAuthorizationPort,
  RecognitionPort,
  SubmissionStore,
} from './ports.js';
import type {
  ProcessingJob,
  ProcessingJobStatus,
  ProcessingJobView,
  RecognitionRegion,
  UploadPageInput,
  UploadSession,
} from './types.js';

const MAX_PAGES = 30;
const MAX_PAGE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const UPLOAD_TTL_MS = 30 * 60_000;

export interface SubmissionServiceDependencies {
  clock?: { readonly now: Date };
  capabilityAuthorization: RecognitionCapabilityAuthorizationPort;
  fileInspection: FileInspectionPort;
  objectStore: ObjectStorePort;
  rawAssetDeletions: RawAssetDeletionPort;
  recognition: RecognitionPort;
  store: SubmissionStore;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function view(job: ProcessingJob): ProcessingJobView {
  return {
    candidate: job.candidate,
    completedContent: job.completedContent,
    errorCode: job.errorCode,
    id: job.id,
    nextAction: job.status === 'unavailable' ? 'retry' : null,
    qualityIssues: job.qualityIssues,
    retryable: job.status === 'unavailable',
    status: job.status,
    updatedAt: job.updatedAt,
  };
}

function validPage(page: UploadPageInput): boolean {
  return (
    page.id.length > 0 &&
    page.fileName.length > 0 &&
    page.fileName.length <= 200 &&
    page.sizeBytes > 0 &&
    page.sizeBytes <= MAX_PAGE_BYTES &&
    /^[a-f\d]{64}$/i.test(page.sha256) &&
    Number.isInteger(page.order) &&
    page.order >= 0
  );
}

export class SubmissionService {
  readonly #clock: { readonly now: Date };
  readonly #capabilityAuthorization: RecognitionCapabilityAuthorizationPort;
  readonly #fileInspection: FileInspectionPort;
  readonly #objectStore: ObjectStorePort;
  readonly #rawAssetDeletions: RawAssetDeletionPort;
  readonly #recognition: RecognitionPort;
  readonly #store: SubmissionStore;

  constructor(dependencies: SubmissionServiceDependencies) {
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#capabilityAuthorization = dependencies.capabilityAuthorization;
    this.#fileInspection = dependencies.fileInspection;
    this.#objectStore = dependencies.objectStore;
    this.#rawAssetDeletions = dependencies.rawAssetDeletions;
    this.#recognition = dependencies.recognition;
    this.#store = dependencies.store;
  }

  async createUploadSession(input: {
    familySpaceId: string;
    learningProfileId: string;
    pages: UploadPageInput[];
  }) {
    const ordered = [...input.pages].sort((left, right) => left.order - right.order);
    const total = ordered.reduce((sum, page) => sum + page.sizeBytes, 0);
    if (
      ordered.length === 0 ||
      ordered.length > MAX_PAGES ||
      total > MAX_TOTAL_BYTES ||
      ordered.some((page, index) => !validPage(page) || page.order !== index) ||
      new Set(ordered.map((page) => page.id)).size !== ordered.length
    ) {
      throw new SubmissionError('INPUT_INVALID', '上传页面、顺序、类型或大小不符合要求');
    }

    const id = randomUUID();
    const tokens = new Map<string, string>();
    const uploadTokenHashes: Record<string, string> = {};
    const pages = ordered.map((page) => {
      const token = randomBytes(24).toString('base64url');
      tokens.set(page.id, token);
      uploadTokenHashes[page.id] = hash(token);
      return {
        ...page,
        objectKey: `ingest-temporary/${input.learningProfileId}/${id}/${page.id}`,
        observedMimeType: null,
        uploadedAt: null,
      };
    });
    const session: UploadSession = {
      createdAt: this.#clock.now.toISOString(),
      expiresAt: new Date(this.#clock.now.getTime() + UPLOAD_TTL_MS).toISOString(),
      familySpaceId: input.familySpaceId,
      id,
      jobId: null,
      learningProfileId: input.learningProfileId,
      pages,
      status: 'open',
      uploadTokenHashes,
    };
    await this.#store.createUploadSession(session);
    return {
      expiresAt: session.expiresAt,
      id,
      pages: pages.map((page) => ({
        id: page.id,
        method: 'PUT' as const,
        uploadToken: tokens.get(page.id)!,
      })),
    };
  }

  async uploadPage(input: {
    bytes: Uint8Array;
    learningProfileId: string;
    pageId: string;
    token: string;
    uploadSessionId: string;
  }): Promise<void> {
    const session = await this.#store.findUploadSession(
      input.uploadSessionId,
      input.learningProfileId,
    );
    const page = session?.pages.find((candidate) => candidate.id === input.pageId);
    if (!session || !page) {
      throw new SubmissionError('UPLOAD_NOT_FOUND', '上传会话或页面不存在');
    }
    if (session.status !== 'open' || Date.parse(session.expiresAt) <= this.#clock.now.getTime()) {
      throw new SubmissionError('UPLOAD_EXPIRED', '上传会话已过期，请重新开始');
    }
    const expected = Buffer.from(session.uploadTokenHashes[input.pageId] ?? '', 'utf8');
    const actual = Buffer.from(hash(input.token), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new SubmissionError('UPLOAD_TOKEN_INVALID', '上传凭证无效或已过期');
    }
    if (input.bytes.byteLength !== page.sizeBytes || hash(input.bytes) !== page.sha256) {
      throw new SubmissionError('INPUT_INVALID', '文件大小或摘要与上传声明不一致');
    }
    await this.#objectStore.put(page.objectKey, input.bytes);
    page.uploadedAt = this.#clock.now.toISOString();
    await this.#store.saveUploadSession(session);
  }

  async submit(input: { learningProfileId: string; uploadSessionId: string }) {
    const upload = await this.#store.findUploadSession(
      input.uploadSessionId,
      input.learningProfileId,
    );
    if (!upload) {
      throw new SubmissionError('UPLOAD_NOT_FOUND', '上传会话不存在');
    }
    if (upload.jobId) {
      const existing = await this.#store.findJob(upload.jobId, input.learningProfileId);
      if (existing) {
        return view(existing);
      }
    }
    if (upload.pages.some((page) => !page.uploadedAt)) {
      throw new SubmissionError('UPLOAD_INCOMPLETE', '仍有页面未上传，草稿已保留');
    }
    const timestamp = this.#clock.now.toISOString();
    const job = await this.#store.createJob({
      candidate: null,
      cancellationVersion: 0,
      completedContent: null,
      createdAt: timestamp,
      errorCode: null,
      familySpaceId: upload.familySpaceId,
      id: randomUUID(),
      learningProfileId: upload.learningProfileId,
      qualityIssues: [],
      revision: 0,
      status: 'queued',
      updatedAt: timestamp,
      uploadSessionId: upload.id,
    });
    return view(job);
  }

  async getJob(input: { id: string; learningProfileId: string }): Promise<ProcessingJobView> {
    const job = await this.#store.findJob(input.id, input.learningProfileId);
    if (!job) {
      throw new SubmissionError('JOB_NOT_FOUND', '识别任务不存在');
    }
    return view(job);
  }

  async cancel(input: { id: string; learningProfileId: string }): Promise<ProcessingJobView> {
    const job = await this.#store.findJob(input.id, input.learningProfileId);
    if (!job) {
      throw new SubmissionError('JOB_NOT_FOUND', '识别任务不存在');
    }
    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      return view(job);
    }
    const canceled = {
      ...job,
      cancellationVersion: job.cancellationVersion + 1,
      revision: job.revision + 1,
      status: 'canceled' as const,
      updatedAt: this.#clock.now.toISOString(),
    };
    if ((await this.#store.saveJobIfRevision(canceled, job.revision)) !== 'saved') {
      return this.getJob(input);
    }
    await this.#deleteRawAssets(job.uploadSessionId, job.learningProfileId);
    return view(canceled);
  }

  async process(id: string, learningProfileId: string): Promise<ProcessingJobView> {
    let job = await this.#requireJob(id, learningProfileId);
    if (job.status !== 'queued' && job.status !== 'unavailable') {
      return view(job);
    }
    job = await this.#transition(job, 'security_check', { errorCode: null });
    const upload = await this.#requiredUpload(job.uploadSessionId, learningProfileId);
    const pages: Array<{ bytes: Uint8Array; page: UploadSession['pages'][number] }> = [];
    const qualityIssues: ProcessingJob['qualityIssues'] = [];
    for (const page of upload.pages) {
      const bytes = await this.#objectStore.get(page.objectKey);
      if (!bytes) {
        return this.#fail(job, 'UPLOAD_INCOMPLETE');
      }
      const inspection = await this.#fileInspection.inspect(page, bytes);
      if (!inspection.safe || !inspection.actualMimeType) {
        return this.#fail(job, 'FILE_UNSAFE');
      }
      page.observedMimeType = inspection.actualMimeType;
      qualityIssues.push(...inspection.qualityIssues.map((issue) => ({ issue, pageId: page.id })));
      pages.push({ bytes, page });
    }
    await this.#store.saveUploadSession(upload);
    job = await this.#transition(job, 'quality_check', { qualityIssues });
    const authorization = await this.#capabilityAuthorization.authorizeCapability({
      capabilityKey: 'ocr.recognition',
      familySpaceId: job.familySpaceId,
      kind: 'ocr',
      slice: {
        basisState: 'not_applicable',
        gradeBand: 'unclassified',
        imageQuality: qualityIssues.length === 0 ? 'clear' : 'degraded',
        questionType: 'unclassified',
        riskLevel: 'unclassified',
        subject: 'unclassified',
      },
    });
    if (authorization.status !== 'authorized' || !authorization.primary) {
      return this.#unavailable(job);
    }
    const beforeSend = await this.#capabilityAuthorization.revalidateAuthorization({
      decisionId: authorization.decisionId,
      expectedContainmentEpoch: authorization.containmentEpoch,
      phase: 'before_send',
      route: 'primary',
    });
    if (beforeSend.status !== 'authorized') {
      return this.#unavailable(job);
    }
    job = await this.#transition(job, 'recognizing');
    const cancellationVersion = job.cancellationVersion;
    const sourceHash = hash(upload.pages.map((page) => page.sha256).join(':'));
    let candidate: Awaited<ReturnType<RecognitionPort['recognize']>>;
    try {
      candidate = await this.#recognition.recognize({
        authorization: beforeSend,
        pages,
        sourceHash,
      });
    } catch {
      const current = await this.#requireJob(id, learningProfileId);
      return current.status === 'canceled' ? view(current) : this.#fail(current, 'OCR_FAILED');
    }
    const current = await this.#requireJob(id, learningProfileId);
    if (
      current.status !== 'recognizing' ||
      current.cancellationVersion !== cancellationVersion ||
      current.revision !== job.revision
    ) {
      return view(current);
    }
    const afterReceive = await this.#capabilityAuthorization.revalidateAuthorization({
      decisionId: authorization.decisionId,
      expectedContainmentEpoch: authorization.containmentEpoch,
      phase: 'after_receive',
      route: 'primary',
    });
    if (afterReceive.status !== 'authorized') {
      return this.#unavailable(current);
    }
    const beforePublish = await this.#capabilityAuthorization.revalidateAuthorization({
      decisionId: authorization.decisionId,
      expectedContainmentEpoch: authorization.containmentEpoch,
      phase: 'before_publish',
      route: 'primary',
    });
    if (beforePublish.status !== 'authorized') {
      return this.#unavailable(current);
    }
    const next: ProcessingJob = {
      ...current,
      candidate: {
        ...candidate,
        adapterVersion: beforePublish.capabilityVersion.adapter.version,
        authorization: beforePublish,
        finishedAt: this.#clock.now.toISOString(),
        id: randomUUID(),
        sourceHash,
      },
      revision: current.revision + 1,
      status: 'awaiting_confirmation',
      updatedAt: this.#clock.now.toISOString(),
    };
    const saved = await this.#store.saveJobIfRevision(next, current.revision);
    if (saved === 'authorization_invalid') {
      return this.#unavailable(current);
    }
    if (saved !== 'saved') {
      return view(await this.#requireJob(id, learningProfileId));
    }
    return view(next);
  }

  async confirm(input: {
    edits: Record<string, string>;
    id: string;
    learningProfileId: string;
  }): Promise<ProcessingJobView> {
    const job = await this.#requireJob(input.id, input.learningProfileId);
    if (job.status !== 'awaiting_confirmation' || !job.candidate) {
      throw new SubmissionError('JOB_STATE_CONFLICT', '当前识别任务不等待内容确认');
    }
    const allowed = new Set(job.candidate.regions.map((region) => region.id));
    if (Object.keys(input.edits).some((id) => !allowed.has(id))) {
      throw new SubmissionError('INPUT_INVALID', '修改内容包含未知识别区域');
    }
    const regions: RecognitionRegion[] = job.candidate.regions.map((region) => ({
      ...region,
      text: input.edits[region.id]?.trim() || region.text,
    }));
    const next: ProcessingJob = {
      ...job,
      completedContent: {
        confirmedAt: this.#clock.now.toISOString(),
        confirmedByLearningProfileId: input.learningProfileId,
        id: randomUUID(),
        regions,
        sourceCandidateId: job.candidate.id,
        sourceHash: job.candidate.sourceHash,
        version: 1,
      },
      revision: job.revision + 1,
      status: 'completed',
      updatedAt: this.#clock.now.toISOString(),
    };
    if ((await this.#store.saveJobIfRevision(next, job.revision)) !== 'saved') {
      throw new SubmissionError('JOB_STATE_CONFLICT', '内容确认状态已变化，请刷新后重试');
    }
    await this.#deleteRawAssets(job.uploadSessionId, job.learningProfileId);
    return view(next);
  }

  async #deleteRawAssets(uploadSessionId: string, learningProfileId: string): Promise<void> {
    const upload = await this.#requiredUpload(uploadSessionId, learningProfileId);
    for (const page of upload.pages) {
      const receipt = await this.#objectStore.delete(page.objectKey);
      await this.#rawAssetDeletions.record({
        learningProfileId,
        objectKey: page.objectKey,
        proof: receipt.proof,
      });
    }
  }

  async #fail(
    job: ProcessingJob,
    errorCode: NonNullable<ProcessingJob['errorCode']>,
  ): Promise<ProcessingJobView> {
    const current = await this.#requireJob(job.id, job.learningProfileId);
    if (current.status === 'canceled') {
      return view(current);
    }
    const failed = {
      ...current,
      errorCode,
      revision: current.revision + 1,
      status: 'failed' as const,
      updatedAt: this.#clock.now.toISOString(),
    };
    if ((await this.#store.saveJobIfRevision(failed, current.revision)) !== 'saved') {
      return view(await this.#requireJob(job.id, job.learningProfileId));
    }
    return view(failed);
  }

  async #unavailable(job: ProcessingJob): Promise<ProcessingJobView> {
    const current = await this.#requireJob(job.id, job.learningProfileId);
    if (current.status === 'canceled') {
      return view(current);
    }
    const unavailable: ProcessingJob = {
      ...current,
      errorCode: 'CAPABILITY_UNAVAILABLE',
      revision: current.revision + 1,
      status: 'unavailable',
      updatedAt: this.#clock.now.toISOString(),
    };
    if ((await this.#store.saveJobIfRevision(unavailable, current.revision)) !== 'saved') {
      return view(await this.#requireJob(job.id, job.learningProfileId));
    }
    return view(unavailable);
  }

  async #requireJob(id: string, learningProfileId: string): Promise<ProcessingJob> {
    const job = await this.#store.findJob(id, learningProfileId);
    if (!job) {
      throw new SubmissionError('JOB_NOT_FOUND', '识别任务不存在');
    }
    return job;
  }

  async #requiredUpload(id: string, learningProfileId: string): Promise<UploadSession> {
    const upload = await this.#store.findUploadSession(id, learningProfileId);
    if (!upload) {
      throw new SubmissionError('UPLOAD_NOT_FOUND', '上传会话不存在');
    }
    return upload;
  }

  async #transition(
    job: ProcessingJob,
    status: ProcessingJobStatus,
    patch: Partial<ProcessingJob> = {},
  ): Promise<ProcessingJob> {
    const next = {
      ...job,
      ...patch,
      revision: job.revision + 1,
      status,
      updatedAt: this.#clock.now.toISOString(),
    };
    if ((await this.#store.saveJobIfRevision(next, job.revision)) !== 'saved') {
      throw new SubmissionError('JOB_STATE_CONFLICT', '识别任务状态已经变化');
    }
    return next;
  }
}
