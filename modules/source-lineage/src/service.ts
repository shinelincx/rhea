import { createHash } from 'node:crypto';

import { SourceLineageError } from './error.js';
import type { SourceLineageStore } from './store.js';
import type {
  ClaimRebuildInput,
  DerivedArtifactIdentity,
  DerivedArtifactRead,
  PublishArtifactInput,
  RecordSourceRevisionInput,
  SettleRebuildInput,
  SourceIdentity,
  SourceRevision,
} from './types.js';

const SOURCE_KINDS = new Set([
  'capability',
  'classification',
  'confirmed_content',
  'current_learning_basis',
  'derived_artifact',
  'grading_basis',
  'learning_source',
  'question',
  'response',
]);
const ARTIFACT_KINDS = new Set([
  'assessment',
  'error_item',
  'explanation',
  'generated_learning',
  'learning_evidence',
  'mastery_evidence',
  'review_card',
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function sourceLineageFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function text(value: string, field: string, maximum = 500): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new SourceLineageError('INPUT_INVALID', `${field} is required`);
  }
  return normalized;
}

function timestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new SourceLineageError('INPUT_INVALID', `${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function sourceIdentity(source: SourceIdentity): SourceIdentity {
  if (!SOURCE_KINDS.has(source.kind)) {
    throw new SourceLineageError('INPUT_INVALID', 'source kind is invalid');
  }
  return {
    familySpaceId: text(source.familySpaceId, 'familySpaceId'),
    id: text(source.id, 'source.id'),
    kind: source.kind,
    learningProfileId: text(source.learningProfileId, 'learningProfileId'),
  };
}

function artifactIdentity(artifact: DerivedArtifactIdentity): DerivedArtifactIdentity {
  if (!ARTIFACT_KINDS.has(artifact.kind)) {
    throw new SourceLineageError('INPUT_INVALID', 'artifact kind is invalid');
  }
  return {
    familySpaceId: text(artifact.familySpaceId, 'familySpaceId'),
    id: text(artifact.id, 'artifact.id'),
    kind: artifact.kind,
    learningProfileId: text(artifact.learningProfileId, 'learningProfileId'),
    version: text(artifact.version, 'artifact.version'),
  };
}

export class SourceLineageService {
  constructor(private readonly store: SourceLineageStore) {}

  async claimRebuild(input: ClaimRebuildInput) {
    const normalized = {
      leaseUntil: timestamp(input.leaseUntil, 'leaseUntil'),
      now: timestamp(input.now, 'now'),
      workerId: text(input.workerId, 'workerId'),
    };
    if (Date.parse(normalized.leaseUntil) <= Date.parse(normalized.now)) {
      throw new SourceLineageError('INPUT_INVALID', 'leaseUntil must be after now');
    }
    return this.store.claimRebuild(normalized);
  }

  async getArtifact(identity: DerivedArtifactIdentity): Promise<DerivedArtifactRead> {
    const artifact = await this.store.findArtifact(artifactIdentity(identity));
    if (!artifact) throw new SourceLineageError('ARTIFACT_NOT_FOUND', 'Derived artifact not found');
    return artifact;
  }

  async getSourceHistory(source: SourceIdentity): Promise<SourceRevision[]> {
    return this.store.listSourceHistory(sourceIdentity(source));
  }

  async publishArtifact(input: PublishArtifactInput): Promise<DerivedArtifactRead> {
    const artifact = {
      ...artifactIdentity(input.artifact),
      rebuildable: input.artifact.rebuildable,
    };
    const dependencies = input.dependencies.map(({ source, usage }) => ({
      source: {
        ...sourceIdentity(source),
        epoch: source.epoch,
        occurredAt: timestamp(source.occurredAt, 'source.occurredAt'),
        predecessorVersion: source.predecessorVersion,
        reason: text(source.reason, 'source.reason'),
        version: text(source.version, 'source.version'),
      },
      usage: text(usage, 'dependency.usage', 120),
    }));
    if (
      dependencies.length === 0 ||
      dependencies.some(
        ({ source }) =>
          source.epoch < 1 ||
          source.familySpaceId !== artifact.familySpaceId ||
          source.learningProfileId !== artifact.learningProfileId,
      )
    ) {
      throw new SourceLineageError('INPUT_INVALID', 'artifact dependencies are incomplete');
    }
    const dependencyKeys = dependencies.map(({ source }) => `${source.kind}\u001f${source.id}`);
    if (new Set(dependencyKeys).size !== dependencyKeys.length) {
      throw new SourceLineageError('INPUT_INVALID', 'artifact dependencies contain duplicates');
    }
    const normalized: PublishArtifactInput = {
      artifact,
      commandId: text(input.commandId, 'commandId'),
      dependencies,
      expectedPreviousVersion: input.expectedPreviousVersion
        ? text(input.expectedPreviousVersion, 'expectedPreviousVersion')
        : null,
      occurredAt: timestamp(input.occurredAt, 'occurredAt'),
    };
    const saved = await this.store.publishArtifact(normalized, {
      commandId: normalized.commandId,
      fingerprint: sourceLineageFingerprint(normalized),
    });
    if (saved.status === 'idempotency_conflict') {
      throw new SourceLineageError(
        'IDEMPOTENCY_CONFLICT',
        'Command was reused with different intent',
      );
    }
    if (saved.status === 'conflict') {
      throw new SourceLineageError('SOURCE_CHANGED', 'A source or prior artifact version changed');
    }
    return saved.value;
  }

  async recordSourceRevision(input: RecordSourceRevisionInput): Promise<SourceRevision> {
    const normalized: RecordSourceRevisionInput = {
      commandId: text(input.commandId, 'commandId'),
      expected: input.expected
        ? {
            epoch: input.expected.epoch,
            version: text(input.expected.version, 'expected.version'),
          }
        : null,
      occurredAt: timestamp(input.occurredAt, 'occurredAt'),
      reason: text(input.reason, 'reason'),
      source: sourceIdentity(input.source),
      version: text(input.version, 'version'),
    };
    if (normalized.expected && normalized.expected.epoch < 1) {
      throw new SourceLineageError('INPUT_INVALID', 'expected epoch is invalid');
    }
    const saved = await this.store.recordSourceRevision(normalized, {
      commandId: normalized.commandId,
      fingerprint: sourceLineageFingerprint(normalized),
    });
    if (saved.status === 'idempotency_conflict') {
      throw new SourceLineageError(
        'IDEMPOTENCY_CONFLICT',
        'Command was reused with different intent',
      );
    }
    if (saved.status === 'conflict') {
      throw new SourceLineageError('VERSION_CONFLICT', 'Source head changed; refresh and retry');
    }
    return saved.value;
  }

  async requireCurrentArtifact(identity: DerivedArtifactIdentity): Promise<DerivedArtifactRead> {
    const artifact = await this.getArtifact(identity);
    if (artifact.freshness !== 'current') {
      throw new SourceLineageError('SOURCE_CHANGED', 'Derived artifact depends on a stale source');
    }
    return artifact;
  }

  async settleRebuild(input: SettleRebuildInput) {
    const normalized: SettleRebuildInput =
      input.outcome === 'completed'
        ? {
            commandId: text(input.commandId, 'commandId'),
            jobId: text(input.jobId, 'jobId'),
            now: timestamp(input.now, 'now'),
            outcome: 'completed',
            replacement: artifactIdentity(input.replacement),
            workerId: text(input.workerId, 'workerId'),
          }
        : {
            commandId: text(input.commandId, 'commandId'),
            errorCode: text(input.errorCode, 'errorCode'),
            jobId: text(input.jobId, 'jobId'),
            now: timestamp(input.now, 'now'),
            outcome: 'failed',
            retryAt: timestamp(input.retryAt, 'retryAt'),
            workerId: text(input.workerId, 'workerId'),
          };
    if (
      normalized.outcome === 'failed' &&
      Date.parse(normalized.retryAt) <= Date.parse(normalized.now)
    ) {
      throw new SourceLineageError('INPUT_INVALID', 'retryAt must be after now');
    }
    const settled = await this.store.settleRebuild(normalized, {
      commandId: normalized.commandId,
      fingerprint: sourceLineageFingerprint(normalized),
    });
    if (settled === 'idempotency_conflict') {
      throw new SourceLineageError(
        'IDEMPOTENCY_CONFLICT',
        'Command was reused with different intent',
      );
    }
    if (settled === 'conflict') {
      throw new SourceLineageError(
        'REBUILD_CONFLICT',
        'Rebuild lease or replacement is no longer current',
      );
    }
    return settled;
  }
}
