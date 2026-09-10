import { randomUUID } from 'node:crypto';

import type { LineageCommandReceipt, LineageSaveResult, SourceLineageStore } from './store.js';
import type {
  ClaimRebuildInput,
  DerivedArtifactIdentity,
  DerivedArtifactRead,
  PublishArtifactInput,
  PublishedDerivedArtifact,
  RebuildJob,
  RecordSourceRevisionInput,
  SettleRebuildInput,
  SourceDependency,
  SourceIdentity,
  SourceRevision,
} from './types.js';

const clone = <Value>(value: Value): Value => structuredClone(value);
const scopeKey = (value: { familySpaceId: string; learningProfileId: string }) =>
  `${value.familySpaceId}\u001f${value.learningProfileId}`;
const sourceKey = (source: SourceIdentity) =>
  `${scopeKey(source)}\u001f${source.kind}\u001f${source.id}`;
const artifactKey = (artifact: DerivedArtifactIdentity) =>
  `${scopeKey(artifact)}\u001f${artifact.kind}\u001f${artifact.id}\u001f${artifact.version}`;
const artifactHeadKey = (
  artifact: Pick<DerivedArtifactIdentity, 'familySpaceId' | 'id' | 'kind' | 'learningProfileId'>,
) => `${scopeKey(artifact)}\u001f${artifact.kind}\u001f${artifact.id}`;

interface StoredArtifact {
  artifact: PublishedDerivedArtifact;
  dependencies: SourceDependency[];
}

interface CommandRecord {
  fingerprint: string;
  value: unknown;
}

export class MemorySourceLineageStore implements SourceLineageStore {
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #artifactHeads = new Map<string, string>();
  readonly #commands = new Map<string, CommandRecord>();
  readonly #jobs = new Map<string, RebuildJob>();
  readonly #sourceHeads = new Map<string, SourceRevision>();
  readonly #sourceHistory = new Map<string, SourceRevision[]>();

  async claimRebuild(input: ClaimRebuildInput): Promise<RebuildJob | null> {
    const now = Date.parse(input.now);
    const eligible = [...this.#jobs.values()]
      .filter(
        (job) =>
          job.status === 'queued' ||
          (job.status === 'retry_wait' && Date.parse(job.retryAt!) <= now) ||
          (job.status === 'running' && Date.parse(job.leaseUntil!) <= now),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )[0];
    if (!eligible) return null;
    eligible.attempt += 1;
    eligible.errorCode = null;
    eligible.leaseUntil = input.leaseUntil;
    eligible.retryAt = null;
    eligible.status = 'running';
    eligible.updatedAt = input.now;
    eligible.workerId = input.workerId;
    const artifact = this.#artifacts.get(artifactKey(eligible.artifact));
    if (artifact && artifact.artifact.status !== 'superseded') artifact.artifact.status = 'stale';
    return clone(eligible);
  }

  async findArtifact(identity: DerivedArtifactIdentity): Promise<DerivedArtifactRead | null> {
    const stored = this.#artifacts.get(artifactKey(identity));
    if (!stored) return null;
    const isHead = this.#artifactHeads.get(artifactHeadKey(identity)) === identity.version;
    const sourcesCurrent = stored.dependencies.every(({ source }) => {
      const head = this.#sourceHeads.get(sourceKey(source));
      return head?.epoch === source.epoch && head.version === source.version;
    });
    const freshness =
      stored.artifact.status === 'current' && isHead && sourcesCurrent ? 'current' : 'stale';
    const rebuild = [...this.#jobs.values()]
      .filter((job) => artifactKey(job.artifact) === artifactKey(identity))
      .sort(
        (left, right) =>
          right.invalidationEpoch - left.invalidationEpoch ||
          right.updatedAt.localeCompare(left.updatedAt),
      )[0];
    return clone({
      artifact: stored.artifact,
      dependencies: stored.dependencies,
      freshness,
      rebuild: rebuild ?? null,
    });
  }

  async listSourceHistory(source: SourceIdentity): Promise<SourceRevision[]> {
    return clone(this.#sourceHistory.get(sourceKey(source)) ?? []);
  }

  async publishArtifact(
    input: PublishArtifactInput,
    receipt: LineageCommandReceipt,
  ): Promise<LineageSaveResult<DerivedArtifactRead>> {
    const replay = this.#commands.get(receipt.commandId);
    if (replay) {
      return replay.fingerprint === receipt.fingerprint
        ? { status: 'duplicate', value: clone(replay.value as DerivedArtifactRead) }
        : { status: 'idempotency_conflict' };
    }
    if (
      input.dependencies.some(({ source }) => {
        const head = this.#sourceHeads.get(sourceKey(source));
        return !head || head.epoch !== source.epoch || head.version !== source.version;
      })
    ) {
      return { status: 'conflict' };
    }
    const headKey = artifactHeadKey(input.artifact);
    const previousVersion = this.#artifactHeads.get(headKey) ?? null;
    if (previousVersion !== input.expectedPreviousVersion) return { status: 'conflict' };
    if (this.#artifacts.has(artifactKey(input.artifact))) return { status: 'conflict' };

    if (previousVersion) {
      const previous = this.#artifacts.get(
        artifactKey({ ...input.artifact, version: previousVersion }),
      );
      if (previous) previous.artifact.status = 'superseded';
    }
    const published: PublishedDerivedArtifact = {
      ...clone(input.artifact),
      invalidatedAt: null,
      invalidationEpoch: 0,
      publishedAt: input.occurredAt,
      status: 'current',
    };
    this.#artifacts.set(artifactKey(input.artifact), {
      artifact: published,
      dependencies: clone(input.dependencies),
    });
    this.#artifactHeads.set(headKey, input.artifact.version);
    this.#advanceDerivedArtifactSource(input.artifact, input.occurredAt);
    const value = (await this.findArtifact(input.artifact))!;
    this.#commands.set(receipt.commandId, {
      fingerprint: receipt.fingerprint,
      value: clone(value),
    });
    return { status: 'saved', value };
  }

  async recordSourceRevision(
    input: RecordSourceRevisionInput,
    receipt: LineageCommandReceipt,
  ): Promise<LineageSaveResult<SourceRevision>> {
    const replay = this.#commands.get(receipt.commandId);
    if (replay) {
      return replay.fingerprint === receipt.fingerprint
        ? { status: 'duplicate', value: clone(replay.value as SourceRevision) }
        : { status: 'idempotency_conflict' };
    }
    const key = sourceKey(input.source);
    const head = this.#sourceHeads.get(key);
    if (
      (input.expected === null && head) ||
      (input.expected !== null &&
        (!head ||
          head.epoch !== input.expected.epoch ||
          head.version !== input.expected.version)) ||
      (this.#sourceHistory.get(key) ?? []).some(({ version }) => version === input.version)
    ) {
      return { status: 'conflict' };
    }
    const revision: SourceRevision = {
      ...clone(input.source),
      epoch: (head?.epoch ?? 0) + 1,
      occurredAt: input.occurredAt,
      predecessorVersion: head?.version ?? null,
      reason: input.reason,
      version: input.version,
    };
    this.#sourceHeads.set(key, revision);
    const history = this.#sourceHistory.get(key) ?? [];
    history.push(revision);
    this.#sourceHistory.set(key, history);
    this.#invalidateDependents(revision);
    this.#commands.set(receipt.commandId, {
      fingerprint: receipt.fingerprint,
      value: clone(revision),
    });
    return { status: 'saved', value: clone(revision) };
  }

  async settleRebuild(
    input: SettleRebuildInput,
    receipt: LineageCommandReceipt,
  ): Promise<'completed' | 'conflict' | 'duplicate' | 'idempotency_conflict' | 'retry_scheduled'> {
    const replay = this.#commands.get(receipt.commandId);
    if (replay) {
      return replay.fingerprint === receipt.fingerprint ? 'duplicate' : 'idempotency_conflict';
    }
    const job = this.#jobs.get(input.jobId);
    if (!job || job.status !== 'running' || job.workerId !== input.workerId) return 'conflict';
    const stored = this.#artifacts.get(artifactKey(job.artifact));
    if (!stored) return 'conflict';
    let result: 'completed' | 'retry_scheduled';
    if (input.outcome === 'failed') {
      job.errorCode = input.errorCode;
      job.leaseUntil = null;
      job.retryAt = input.retryAt;
      job.status = 'retry_wait';
      job.updatedAt = input.now;
      stored.artifact.status = 'rebuild_failed';
      result = 'retry_scheduled';
    } else {
      const replacement = await this.findArtifact(input.replacement);
      if (
        !replacement ||
        replacement.freshness !== 'current' ||
        input.replacement.kind !== job.artifact.kind ||
        input.replacement.id !== job.artifact.id ||
        input.replacement.version === job.artifact.version
      ) {
        return 'conflict';
      }
      job.errorCode = null;
      job.leaseUntil = null;
      job.retryAt = null;
      job.status = 'completed';
      job.updatedAt = input.now;
      stored.artifact.status = 'superseded';
      result = 'completed';
    }
    this.#commands.set(receipt.commandId, { fingerprint: receipt.fingerprint, value: result });
    return result;
  }

  #advanceDerivedArtifactSource(artifact: DerivedArtifactIdentity, occurredAt: string): void {
    const source: SourceIdentity = {
      familySpaceId: artifact.familySpaceId,
      id: `${artifact.kind}:${artifact.id}`,
      kind: 'derived_artifact',
      learningProfileId: artifact.learningProfileId,
    };
    const key = sourceKey(source);
    const head = this.#sourceHeads.get(key);
    const revision: SourceRevision = {
      ...source,
      epoch: (head?.epoch ?? 0) + 1,
      occurredAt,
      predecessorVersion: head?.version ?? null,
      reason: 'derived artifact published',
      version: artifact.version,
    };
    this.#sourceHeads.set(key, revision);
    const history = this.#sourceHistory.get(key) ?? [];
    history.push(revision);
    this.#sourceHistory.set(key, history);
    this.#invalidateDependents(revision);
  }

  #invalidateDependents(current: SourceRevision): void {
    for (const stored of this.#artifacts.values()) {
      if (
        stored.artifact.status === 'superseded' ||
        !stored.dependencies.some(
          ({ source }) =>
            sourceKey(source) === sourceKey(current) &&
            (source.epoch !== current.epoch || source.version !== current.version),
        )
      ) {
        continue;
      }
      stored.artifact.invalidationEpoch += 1;
      stored.artifact.invalidatedAt = current.occurredAt;
      stored.artifact.status = 'stale';
      for (const job of this.#jobs.values()) {
        if (
          artifactKey(job.artifact) === artifactKey(stored.artifact) &&
          !['completed', 'superseded'].includes(job.status)
        ) {
          job.status = 'superseded';
          job.updatedAt = current.occurredAt;
        }
      }
      if (stored.artifact.rebuildable) {
        const job: RebuildJob = {
          artifact: {
            familySpaceId: stored.artifact.familySpaceId,
            id: stored.artifact.id,
            kind: stored.artifact.kind,
            learningProfileId: stored.artifact.learningProfileId,
            version: stored.artifact.version,
          },
          attempt: 0,
          createdAt: current.occurredAt,
          errorCode: null,
          id: randomUUID(),
          invalidationEpoch: stored.artifact.invalidationEpoch,
          leaseUntil: null,
          retryAt: null,
          status: 'queued',
          updatedAt: current.occurredAt,
          workerId: null,
        };
        this.#jobs.set(job.id, job);
      }
    }
  }
}
