import type {
  ClaimRebuildInput,
  DerivedArtifactIdentity,
  DerivedArtifactRead,
  PublishArtifactInput,
  RebuildJob,
  RecordSourceRevisionInput,
  SettleRebuildInput,
  SourceIdentity,
  SourceRevision,
} from './types.js';

export interface LineageCommandReceipt {
  commandId: string;
  fingerprint: string;
}

export type LineageSaveResult<Value> =
  | { status: 'conflict' }
  | { status: 'idempotency_conflict' }
  | { status: 'saved' | 'duplicate'; value: Value };

export interface SourceLineageStore {
  claimRebuild(input: ClaimRebuildInput): Promise<RebuildJob | null>;
  findArtifact(identity: DerivedArtifactIdentity): Promise<DerivedArtifactRead | null>;
  listSourceHistory(source: SourceIdentity): Promise<SourceRevision[]>;
  publishArtifact(
    input: PublishArtifactInput,
    receipt: LineageCommandReceipt,
  ): Promise<LineageSaveResult<DerivedArtifactRead>>;
  recordSourceRevision(
    input: RecordSourceRevisionInput,
    receipt: LineageCommandReceipt,
  ): Promise<LineageSaveResult<SourceRevision>>;
  settleRebuild(
    input: SettleRebuildInput,
    receipt: LineageCommandReceipt,
  ): Promise<'completed' | 'conflict' | 'duplicate' | 'idempotency_conflict' | 'retry_scheduled'>;
}
