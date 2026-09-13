export interface PrivacyScope {
  familySpaceId: string;
  learningProfileId: string;
}
export type PrivacyTaskKind = 'export' | 'erasure';
export type PrivacyTaskStatus =
  'completed' | 'failed' | 'pending' | 'processing' | 'retry_scheduled';
export type ErasureTarget =
  'active_database' | 'cache' | 'key_wrap' | 'object_storage' | 'vendor_copies';

export interface PrivacyTask extends PrivacyScope {
  attempts: number;
  completedAt: string | null;
  createdAt: string;
  deadlineAt: string;
  download: null | { expiresAt: string; objectKey: string };
  errorCode: string | null;
  id: string;
  kind: PrivacyTaskKind;
  requestedByGuardianId: string;
  status: PrivacyTaskStatus;
  targetReceipts: Partial<Record<ErasureTarget, string>>;
  updatedAt: string;
}

export interface ErasurePreview extends PrivacyScope {
  confirmationText: string;
  deadlineDays: 30;
  effects: string[];
  targets: ErasureTarget[];
}

export interface ErasureTombstone {
  completedAt: string;
  completionCertificateId: string;
  createdAt: string;
  subjectToken: string;
  taskId: string;
  targetNames: ErasureTarget[];
}

export interface ErasureCertificate {
  completedAt: string;
  id: string;
  statement: string;
  targetNames: ErasureTarget[];
  taskId: string;
}

export interface ExportBundle {
  contentTypes: string[];
  generatedAt: string;
  objectKey: string;
  sourceHistoryIncluded: true;
  stateHistoryIncluded: true;
}

export interface ExportDownload {
  fileName: string;
  generatedAt: string;
  payload: unknown;
}
