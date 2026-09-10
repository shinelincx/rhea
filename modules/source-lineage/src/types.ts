export type SourceKind =
  | 'capability'
  | 'classification'
  | 'confirmed_content'
  | 'current_learning_basis'
  | 'derived_artifact'
  | 'grading_basis'
  | 'learning_source'
  | 'question'
  | 'response';

export type DerivedArtifactKind =
  | 'assessment'
  | 'error_item'
  | 'explanation'
  | 'generated_learning'
  | 'learning_evidence'
  | 'mastery_evidence'
  | 'review_card';

export interface LineageScope {
  familySpaceId: string;
  learningProfileId: string;
}

export interface SourceIdentity extends LineageScope {
  id: string;
  kind: SourceKind;
}

export interface SourceRevision extends SourceIdentity {
  epoch: number;
  occurredAt: string;
  predecessorVersion: string | null;
  reason: string;
  version: string;
}

export interface SourceExpectation {
  epoch: number;
  version: string;
}

export interface SourceDependency {
  source: SourceRevision;
  usage: string;
}

export interface DerivedArtifactIdentity extends LineageScope {
  id: string;
  kind: DerivedArtifactKind;
  version: string;
}

export interface PublishedDerivedArtifact extends DerivedArtifactIdentity {
  invalidatedAt: string | null;
  invalidationEpoch: number;
  publishedAt: string;
  rebuildable: boolean;
  status: 'current' | 'rebuild_failed' | 'stale' | 'superseded';
}

export type RebuildJobStatus = 'completed' | 'queued' | 'retry_wait' | 'running' | 'superseded';

export interface RebuildJob {
  artifact: DerivedArtifactIdentity;
  attempt: number;
  createdAt: string;
  errorCode: string | null;
  id: string;
  invalidationEpoch: number;
  leaseUntil: string | null;
  retryAt: string | null;
  status: RebuildJobStatus;
  updatedAt: string;
  workerId: string | null;
}

export interface DerivedArtifactRead {
  artifact: PublishedDerivedArtifact;
  dependencies: SourceDependency[];
  freshness: 'current' | 'stale';
  rebuild: RebuildJob | null;
}

export interface RecordSourceRevisionInput {
  commandId: string;
  expected: SourceExpectation | null;
  occurredAt: string;
  reason: string;
  source: SourceIdentity;
  version: string;
}

export interface PublishArtifactInput {
  artifact: DerivedArtifactIdentity & { rebuildable: boolean };
  commandId: string;
  dependencies: SourceDependency[];
  expectedPreviousVersion: string | null;
  occurredAt: string;
}

export interface ClaimRebuildInput {
  leaseUntil: string;
  now: string;
  workerId: string;
}

export type SettleRebuildInput =
  | {
      commandId: string;
      jobId: string;
      now: string;
      outcome: 'completed';
      replacement: DerivedArtifactIdentity;
      workerId: string;
    }
  | {
      commandId: string;
      errorCode: string;
      jobId: string;
      now: string;
      outcome: 'failed';
      retryAt: string;
      workerId: string;
    };
