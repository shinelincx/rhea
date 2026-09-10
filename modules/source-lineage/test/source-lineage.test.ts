import { describe, expect, it } from 'vitest';

import {
  MemorySourceLineageStore,
  SourceLineageError,
  SourceLineageService,
} from '../src/index.js';

const scope = { familySpaceId: 'family-1', learningProfileId: 'profile-1' };
const at = (minute: number) => `2026-09-10T08:${minute.toString().padStart(2, '0')}:00.000Z`;

describe('source lineage', () => {
  it('keeps immutable source history and immediately rejects every stale derived learning fact', async () => {
    const lineage = new SourceLineageService(new MemorySourceLineageStore());
    const question = await lineage.recordSourceRevision({
      commandId: 'question-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'confirmed question',
      source: { ...scope, id: 'question-1', kind: 'question' },
      version: 'question-v1',
    });
    const response = await lineage.recordSourceRevision({
      commandId: 'response-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'confirmed response',
      source: { ...scope, id: 'response-1', kind: 'response' },
      version: 'response-v1',
    });
    const basis = await lineage.recordSourceRevision({
      commandId: 'basis-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'selected current learning basis',
      source: { ...scope, id: 'material-1', kind: 'current_learning_basis' },
      version: 'basis-v1',
    });
    const gradingBasis = await lineage.recordSourceRevision({
      commandId: 'grading-basis-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'confirmed grading basis',
      source: { ...scope, id: 'grading-basis-1', kind: 'grading_basis' },
      version: 'grading-basis-v1',
    });
    const dependencies = [question, response, basis, gradingBasis].map((source) => ({
      source,
      usage: 'authoritative_input',
    }));

    for (const [index, kind] of (
      [
        'assessment',
        'explanation',
        'error_item',
        'review_card',
        'learning_evidence',
        'mastery_evidence',
      ] as const
    ).entries()) {
      await lineage.publishArtifact({
        artifact: {
          ...scope,
          id: `${kind}-1`,
          kind,
          rebuildable: kind !== 'learning_evidence' && kind !== 'mastery_evidence',
          version: `${kind}-v1`,
        },
        commandId: `publish-${kind}-v1`,
        dependencies,
        expectedPreviousVersion: null,
        occurredAt: at(index + 1),
      });
    }

    const corrected = await lineage.recordSourceRevision({
      commandId: 'question-v2',
      expected: { epoch: question.epoch, version: question.version },
      occurredAt: at(10),
      reason: 'guardian corrected question',
      source: question,
      version: 'question-v2',
    });

    expect(corrected).toMatchObject({ epoch: 2, predecessorVersion: 'question-v1' });
    expect(await lineage.getSourceHistory(question)).toMatchObject([
      { epoch: 1, version: 'question-v1' },
      { epoch: 2, predecessorVersion: 'question-v1', version: 'question-v2' },
    ]);
    for (const kind of [
      'assessment',
      'explanation',
      'error_item',
      'review_card',
      'learning_evidence',
      'mastery_evidence',
    ] as const) {
      const state = await lineage.getArtifact({
        ...scope,
        id: `${kind}-1`,
        kind,
        version: `${kind}-v1`,
      });
      expect(state).toMatchObject({
        artifact: { invalidationEpoch: 1, status: 'stale' },
        freshness: 'stale',
      });
      await expect(
        lineage.requireCurrentArtifact({
          ...scope,
          id: `${kind}-1`,
          kind,
          version: `${kind}-v1`,
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    }
  });

  it('retries rebuilds without duplicate jobs or reviving stale conclusions', async () => {
    const lineage = new SourceLineageService(new MemorySourceLineageStore());
    const sourceV1 = await lineage.recordSourceRevision({
      commandId: 'source-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'initial source',
      source: { ...scope, id: 'basis-1', kind: 'current_learning_basis' },
      version: 'basis-v1',
    });
    await lineage.publishArtifact({
      artifact: {
        ...scope,
        id: 'card-1',
        kind: 'review_card',
        rebuildable: true,
        version: 'card-v1',
      },
      commandId: 'card-v1',
      dependencies: [{ source: sourceV1, usage: 'authoritative_input' }],
      expectedPreviousVersion: null,
      occurredAt: at(1),
    });
    const sourceV2 = await lineage.recordSourceRevision({
      commandId: 'source-v2',
      expected: { epoch: 1, version: 'basis-v1' },
      occurredAt: at(2),
      reason: 'basis changed',
      source: sourceV1,
      version: 'basis-v2',
    });
    await lineage.recordSourceRevision({
      commandId: 'source-v2',
      expected: { epoch: 1, version: 'basis-v1' },
      occurredAt: at(2),
      reason: 'basis changed',
      source: sourceV1,
      version: 'basis-v2',
    });

    const first = await lineage.claimRebuild({
      leaseUntil: at(5),
      now: at(3),
      workerId: 'worker-1',
    });
    expect(first).toMatchObject({ artifact: { id: 'card-1' }, attempt: 1, status: 'running' });
    expect(
      await lineage.claimRebuild({ leaseUntil: at(5), now: at(3), workerId: 'worker-2' }),
    ).toBeNull();
    await lineage.settleRebuild({
      commandId: 'fail-card-rebuild-1',
      errorCode: 'GENERATOR_UNAVAILABLE',
      jobId: first!.id,
      now: at(4),
      outcome: 'failed',
      retryAt: at(6),
      workerId: 'worker-1',
    });
    expect(await lineage.getArtifact(first!.artifact)).toMatchObject({
      freshness: 'stale',
      rebuild: { attempt: 1, errorCode: 'GENERATOR_UNAVAILABLE', status: 'retry_wait' },
    });
    expect(
      await lineage.claimRebuild({ leaseUntil: at(8), now: at(5), workerId: 'worker-2' }),
    ).toBeNull();
    const retry = await lineage.claimRebuild({
      leaseUntil: at(8),
      now: at(6),
      workerId: 'worker-2',
    });
    expect(retry).toMatchObject({ id: first!.id, attempt: 2, status: 'running' });

    await lineage.publishArtifact({
      artifact: {
        ...scope,
        id: 'card-1',
        kind: 'review_card',
        rebuildable: true,
        version: 'card-v2',
      },
      commandId: 'card-v2',
      dependencies: [{ source: sourceV2, usage: 'authoritative_input' }],
      expectedPreviousVersion: 'card-v1',
      occurredAt: at(7),
    });
    const completed = {
      commandId: 'complete-card-rebuild-2',
      jobId: retry!.id,
      now: at(7),
      outcome: 'completed' as const,
      replacement: {
        ...scope,
        id: 'card-1',
        kind: 'review_card' as const,
        version: 'card-v2',
      },
      workerId: 'worker-2',
    };
    await expect(lineage.settleRebuild(completed)).resolves.toBe('completed');
    await expect(lineage.settleRebuild(completed)).resolves.toBe('duplicate');
    await expect(lineage.requireCurrentArtifact(completed.replacement)).resolves.toMatchObject({
      freshness: 'current',
    });
    await expect(lineage.requireCurrentArtifact(first!.artifact)).rejects.toBeInstanceOf(
      SourceLineageError,
    );
  });

  it('fails closed on stale publish inputs and command replays with different intent', async () => {
    const lineage = new SourceLineageService(new MemorySourceLineageStore());
    const original = await lineage.recordSourceRevision({
      commandId: 'source-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'initial',
      source: { ...scope, id: 'question-1', kind: 'question' },
      version: 'v1',
    });
    await lineage.recordSourceRevision({
      commandId: 'source-v2',
      expected: { epoch: 1, version: 'v1' },
      occurredAt: at(1),
      reason: 'corrected',
      source: original,
      version: 'v2',
    });
    await expect(
      lineage.publishArtifact({
        artifact: {
          ...scope,
          id: 'assessment-1',
          kind: 'assessment',
          rebuildable: true,
          version: 'assessment-v1',
        },
        commandId: 'stale-publish',
        dependencies: [{ source: original, usage: 'authoritative_input' }],
        expectedPreviousVersion: null,
        occurredAt: at(2),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(
      lineage.recordSourceRevision({
        commandId: 'source-v2',
        expected: { epoch: 1, version: 'v1' },
        occurredAt: at(1),
        reason: 'different correction',
        source: original,
        version: 'v3',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects duplicate dependency identities before reaching an adapter', async () => {
    const lineage = new SourceLineageService(new MemorySourceLineageStore());
    const source = await lineage.recordSourceRevision({
      commandId: 'source-v1',
      expected: null,
      occurredAt: at(0),
      reason: 'initial',
      source: { ...scope, id: 'question-1', kind: 'question' },
      version: 'v1',
    });
    await expect(
      lineage.publishArtifact({
        artifact: {
          ...scope,
          id: 'assessment-1',
          kind: 'assessment',
          rebuildable: true,
          version: 'assessment-v1',
        },
        commandId: 'duplicate-dependencies',
        dependencies: [
          { source, usage: 'question' },
          { source, usage: 'question_again' },
        ],
        expectedPreviousVersion: null,
        occurredAt: at(1),
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });
});
