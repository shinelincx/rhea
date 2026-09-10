import type {
  ProcessingJob,
  QualityIssue,
  RecognitionCandidate,
  UploadPage,
  UploadSession,
} from './types.js';

export interface SubmissionStore {
  createJob(job: ProcessingJob): Promise<ProcessingJob>;
  createUploadSession(session: UploadSession): Promise<void>;
  findJob(id: string, learningProfileId: string): Promise<ProcessingJob | null>;
  findUploadSession(id: string, learningProfileId?: string): Promise<UploadSession | null>;
  saveJobIfRevision(job: ProcessingJob, expectedRevision: number): Promise<SaveJobResult>;
  saveUploadSession(session: UploadSession): Promise<void>;
}

export type SaveJobResult = 'authorization_invalid' | 'revision_conflict' | 'saved';

export interface ObjectStorePort {
  delete(key: string): Promise<{ proof: string }>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface FileInspectionResult {
  actualMimeType: string | null;
  qualityIssues: QualityIssue[];
  safe: boolean;
}

export interface FileInspectionPort {
  inspect(page: UploadPage, bytes: Uint8Array): Promise<FileInspectionResult>;
}

export interface RecognitionPort {
  recognize(input: {
    authorization: RecognitionCandidate['authorization'];
    pages: Array<{ bytes: Uint8Array; page: UploadPage }>;
    sourceHash: string;
  }): Promise<Pick<RecognitionCandidate, 'regions'>>;
}

export interface RecognitionCapabilityAuthorizationPort {
  authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision>;
  revalidateAuthorization(input: RevalidateAuthorizationInput): Promise<AuthorizationRevalidation>;
}

export interface RawAssetDeletionReceipt {
  learningProfileId: string;
  objectKey: string;
  proof: string;
}

export interface RawAssetDeletionPort {
  record(input: RawAssetDeletionReceipt): Promise<void>;
}
import type {
  AuthorizationDecision,
  AuthorizationRevalidation,
  AuthorizeCapabilityInput,
  RevalidateAuthorizationInput,
} from '@rhea/quality-control';
