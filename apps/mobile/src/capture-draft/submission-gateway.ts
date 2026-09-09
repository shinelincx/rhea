import { CryptoDigestAlgorithm, digest } from 'expo-crypto';

import type { CaptureDraft } from './model';

export type MobileProcessingStatus =
  | 'queued'
  | 'security_check'
  | 'quality_check'
  | 'recognizing'
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface MobileRecognitionRegion {
  confidence: number;
  id: string;
  kind: 'question' | 'answer' | 'shared_prompt';
  lowConfidence: boolean;
  pageId: string;
  readingOrder: number;
  text: string;
}

export interface MobileProcessingJob {
  candidate: {
    adapterVersion: string;
    id: string;
    regions: MobileRecognitionRegion[];
    sourceHash: string;
  } | null;
  completedContent: { id: string; sourceCandidateId: string; sourceHash: string } | null;
  errorCode: string | null;
  id: string;
  qualityIssues: Array<{
    issue: 'blurry' | 'too_dark' | 'glare' | 'missing_edge';
    pageId: string;
  }>;
  status: MobileProcessingStatus;
  updatedAt: string;
}

export type MobileSubject = 'chinese' | 'mathematics' | 'english' | 'science';

export interface MobileClassificationDraft {
  coursePathName: string | null;
  knowledgePointNames: string[];
  primaryKnowledgePointName: string | null;
  primarySubject: MobileSubject | null;
  relatedSubjects: MobileSubject[];
  unitName: string | null;
}

export interface MobileLearningMaterial {
  basis: {
    currentSourceVersionId: string;
    hasConflict: boolean;
    selectionRevision: number;
  };
  currentClassification: {
    primarySubject: MobileSubject | null;
    revision: number;
    status: 'classified' | 'pending';
  };
  id: string;
  sourceVersions: Array<{ id: string; versionLabel: string }>;
}

export interface SubmissionGateway {
  cancel(accessToken: string, id: string): Promise<MobileProcessingJob>;
  confirm(
    accessToken: string,
    id: string,
    edits: Record<string, string>,
  ): Promise<MobileProcessingJob>;
  getJob(accessToken: string, id: string): Promise<MobileProcessingJob>;
  organize(input: {
    accessToken: string;
    classification: MobileClassificationDraft;
    familySpaceId: string;
    learningProfileId: string;
    processingJobId: string;
  }): Promise<MobileLearningMaterial>;
  submit(input: {
    accessToken: string;
    draft: CaptureDraft;
    onProgress?: (uploaded: number, total: number) => void;
    pageContents: ReadonlyMap<string, Uint8Array>;
  }): Promise<MobileProcessingJob>;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; recovery?: string };
}

export class SubmissionGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = 'SubmissionGatewayError';
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const stableBytes = Uint8Array.from(bytes);
  return hex(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, stableBytes)));
}

export function createSubmissionGateway(baseUrl: string): SubmissionGateway {
  const root = baseUrl.replace(/\/$/, '');

  async function request<Data>(path: string, options: RequestInit): Promise<Data> {
    const response = await fetch(path.startsWith('http') ? path : `${root}${path}`, options);
    if (!response.ok) {
      const error = ((await response.json().catch(() => ({}))) as ErrorEnvelope).error;
      throw new SubmissionGatewayError(
        error?.code ?? 'NETWORK_ERROR',
        error?.message ?? '上传或识别暂时没有完成，请稍后重试。',
        error?.recovery,
      );
    }
    if (response.status === 204) {
      return undefined as Data;
    }
    return ((await response.json()) as { data: Data }).data;
  }

  const authorization = (accessToken: string) => ({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  return {
    cancel(accessToken, id) {
      return request(`/v1/processing-jobs/${id}/cancel`, {
        headers: authorization(accessToken),
        method: 'POST',
      });
    },
    confirm(accessToken, id, edits) {
      return request(`/v1/content-confirmations/${id}`, {
        body: JSON.stringify({ edits }),
        headers: { ...authorization(accessToken), 'Content-Type': 'application/json' },
        method: 'PUT',
      });
    },
    getJob(accessToken, id) {
      return request(`/v1/processing-jobs/${id}`, {
        headers: authorization(accessToken),
        method: 'GET',
      });
    },
    organize(input) {
      return request(
        `/v1/family-spaces/${encodeURIComponent(input.familySpaceId)}/learning-profiles/${encodeURIComponent(input.learningProfileId)}/learning-materials`,
        {
          body: JSON.stringify({
            classification: input.classification,
            processingJobId: input.processingJobId,
          }),
          headers: { ...authorization(input.accessToken), 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
    },
    async submit(input) {
      const pages = await Promise.all(
        input.draft.pages.map(async (page, order) => {
          const bytes = input.pageContents.get(page.id);
          if (!bytes) {
            throw new SubmissionGatewayError(
              'UPLOAD_INCOMPLETE',
              `${page.fileName} 的草稿内容不存在`,
            );
          }
          return { ...page, order, sha256: await sha256(bytes) };
        }),
      );
      const upload = await request<{
        id: string;
        pages: Array<{ id: string; method: 'PUT'; url: string }>;
      }>('/v1/upload-sessions', {
        body: JSON.stringify({ pages }),
        headers: { ...authorization(input.accessToken), 'Content-Type': 'application/json' },
        method: 'POST',
      });
      let uploaded = 0;
      for (const target of upload.pages) {
        const page = input.draft.pages.find((candidate) => candidate.id === target.id)!;
        const bytes = input.pageContents.get(target.id)!;
        await request<void>(target.url, {
          body: Uint8Array.from(bytes) as unknown as BodyInit,
          headers: { 'Content-Type': page.mimeType },
          method: target.method,
        });
        uploaded += 1;
        input.onProgress?.(uploaded, upload.pages.length);
      }
      return request<MobileProcessingJob>('/v1/submissions', {
        body: JSON.stringify({ uploadSessionId: upload.id }),
        headers: { ...authorization(input.accessToken), 'Content-Type': 'application/json' },
        method: 'POST',
      });
    },
  };
}
