export type ProcessingJobStatus =
  | 'queued'
  | 'security_check'
  | 'quality_check'
  | 'recognizing'
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed'
  | 'canceled';

export type QualityIssue = 'blurry' | 'too_dark' | 'glare' | 'missing_edge';

export interface UploadPageInput {
  crop: { height: number; width: number; x: number; y: number } | null;
  fileName: string;
  height: number | null;
  id: string;
  mimeType: string;
  order: number;
  rotation: 0 | 90 | 180 | 270;
  sha256: string;
  sizeBytes: number;
  width: number | null;
}

export interface UploadPage extends UploadPageInput {
  objectKey: string;
  observedMimeType: string | null;
  uploadedAt: string | null;
}

export interface UploadSession {
  createdAt: string;
  expiresAt: string;
  familySpaceId: string;
  id: string;
  jobId: string | null;
  learningProfileId: string;
  pages: UploadPage[];
  status: 'open' | 'submitted' | 'canceled';
  uploadTokenHashes: Record<string, string>;
}

export interface RecognitionRegion {
  confidence: number;
  id: string;
  kind: 'question' | 'answer' | 'shared_prompt';
  lowConfidence: boolean;
  pageId: string;
  polygon: Array<{ x: number; y: number }>;
  questionRegionId: string | null;
  readingOrder: number;
  text: string;
}

export interface RecognitionCandidate {
  adapterVersion: string;
  id: string;
  regions: RecognitionRegion[];
  sourceHash: string;
}

export interface ConfirmedContent {
  confirmedAt: string;
  confirmedByLearningProfileId: string;
  id: string;
  regions: RecognitionRegion[];
  sourceCandidateId: string;
  sourceHash: string;
  version: number;
}

export interface ProcessingJob {
  candidate: RecognitionCandidate | null;
  cancellationVersion: number;
  completedContent: ConfirmedContent | null;
  createdAt: string;
  errorCode: 'FILE_UNSAFE' | 'OCR_FAILED' | 'UPLOAD_INCOMPLETE' | null;
  familySpaceId: string;
  id: string;
  learningProfileId: string;
  qualityIssues: Array<{ issue: QualityIssue; pageId: string }>;
  revision: number;
  status: ProcessingJobStatus;
  updatedAt: string;
  uploadSessionId: string;
}

export interface ProcessingJobView {
  candidate: RecognitionCandidate | null;
  completedContent: ConfirmedContent | null;
  errorCode: ProcessingJob['errorCode'];
  id: string;
  qualityIssues: ProcessingJob['qualityIssues'];
  status: ProcessingJobStatus;
  updatedAt: string;
}
