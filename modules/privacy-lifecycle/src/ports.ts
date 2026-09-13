import type {
  ErasureTarget,
  ErasureTombstone,
  ExportBundle,
  ExportDownload,
  PrivacyScope,
} from './types.js';

export interface PrivacyDataPort {
  archiveTombstone(tombstone: ErasureTombstone): Promise<void>;
  deleteTarget(input: PrivacyScope & { target: ErasureTarget }): Promise<{ receipt: string }>;
  downloadExport(input: PrivacyScope & { taskId: string }): Promise<ExportDownload>;
  exportProfile(input: PrivacyScope & { taskId: string }): Promise<ExportBundle>;
  freezeProfile(input: PrivacyScope): Promise<void>;
  profileExists(input: PrivacyScope): Promise<boolean>;
  purgeExpiredExports(): Promise<number>;
}
