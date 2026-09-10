import { describe, expect, it } from 'vitest';

import {
  MemoryQualityControlStore,
  QualityControlService,
  type CapabilityUseSlice,
  type CapabilityVersion,
  type RequiredSlicePolicy,
} from '../src/index.js';

const registeredAt = '2026-09-10T08:00:00.000Z';

const requiredSlices = [
  {
    basisState: 'current',
    gradeBand: 'lower_primary',
    imageQuality: 'clear',
    questionType: 'objective',
    riskLevel: 'low',
    subject: 'chinese',
  },
  {
    basisState: 'conflicted',
    gradeBand: 'middle_primary',
    imageQuality: 'degraded',
    questionType: 'open_response',
    riskLevel: 'medium',
    subject: 'mathematics',
  },
  {
    basisState: 'insufficient',
    gradeBand: 'upper_primary',
    imageQuality: 'unusable',
    questionType: 'process',
    riskLevel: 'high',
    subject: 'english',
  },
  {
    basisState: 'current',
    gradeBand: 'lower_primary',
    imageQuality: 'clear',
    questionType: 'oral',
    riskLevel: 'low',
    subject: 'science',
  },
  {
    basisState: 'conflicted',
    gradeBand: 'middle_primary',
    imageQuality: 'degraded',
    questionType: 'science_observation',
    riskLevel: 'medium',
    subject: 'science',
  },
] as const;

const slicePolicy = {
  minimumSampleSize: 20,
  registeredAt,
  requiredSignoffRoles: ['quality_owner', 'domain_reviewer', 'child_safety'],
  requiredSlices,
  version: 'quality-policy-v1',
} satisfies RequiredSlicePolicy;

const generatedLearningUseSlice = {
  basisState: 'current',
  gradeBand: 'middle_primary',
  imageQuality: 'not_applicable',
  questionType: 'process',
  riskLevel: 'medium',
  subject: 'mathematics',
} satisfies CapabilityUseSlice;

function capability(id = 'generation-v2'): CapabilityVersion {
  return {
    adapter: { id: 'bailian-adapter', version: '2.1.0' },
    artifactHash: 'a'.repeat(64),
    capabilityKey: 'ai.generated-learning',
    id,
    implementedBy: 'engineer-1',
    kind: 'ai',
    modelOrEngine: { id: 'qwen', version: '2026-08-15' },
    policyVersion: 'child-learning-policy-v3',
    promptOrConfig: { kind: 'prompt', version: 'generation-prompt-v4' },
    provider: { id: 'bailian', version: 'contract-v2' },
    region: 'cn-beijing',
    registeredAt,
    requiredSlicePolicyVersion: slicePolicy.version,
    templateVersion: 'learning-pack-v3',
  };
}

async function evaluatedCapability(
  qualityControl: QualityControlService,
  id = 'generation-v2',
  registerPolicy = true,
) {
  if (registerPolicy) {
    await qualityControl.registerSlicePolicy({
      commandId: `policy-${id}`,
      policy: slicePolicy,
    });
  }
  await qualityControl.registerCapability({
    commandId: `register-${id}`,
    version: capability(id),
  });
  let revision = 0;
  for (const [index, slice] of requiredSlices.entries()) {
    const record = await qualityControl.recordEvaluation({
      commandId: `evaluation-${id}-${index}`,
      expectedRevision: revision,
      run: {
        capabilityVersionId: id,
        completedAt: `2026-09-10T09:0${index}:00.000Z`,
        evidenceHash: String(index + 1).repeat(64),
        id: `run-${id}-${index}`,
        metrics: { criticalErrorCount: 0, passRate: 1 },
        outcome: 'passed',
        policyVersion: slicePolicy.version,
        sampleSize: 100,
        slice,
      },
    });
    revision = record.revision;
  }
  return {
    card: await qualityControl.getQualityCard(id),
    record: await qualityControl.getCapability(id),
  };
}

async function signedCapability(
  qualityControl: QualityControlService,
  id = 'generation-v2',
  registerPolicy = true,
) {
  const evaluated = await evaluatedCapability(qualityControl, id, registerPolicy);
  let qualification = await qualityControl.signOffCapability({
    commandId: `quality-signoff-${id}`,
    evidenceHash: evaluated.card.evidenceHash,
    expectedRevision: evaluated.record.revision,
    policyVersion: slicePolicy.version,
    signedAt: '2026-09-10T10:01:00.000Z',
    signer: { id: 'quality-1', role: 'quality_owner' },
    capabilityVersionId: id,
  });
  qualification = await qualityControl.signOffCapability({
    commandId: `domain-signoff-${id}`,
    evidenceHash: evaluated.card.evidenceHash,
    expectedRevision: qualification.revision,
    policyVersion: slicePolicy.version,
    signedAt: '2026-09-10T10:02:00.000Z',
    signer: { id: 'domain-1', role: 'domain_reviewer' },
    capabilityVersionId: id,
  });
  qualification = await qualityControl.signOffCapability({
    commandId: `safety-signoff-${id}`,
    evidenceHash: evaluated.card.evidenceHash,
    expectedRevision: qualification.revision,
    policyVersion: slicePolicy.version,
    signedAt: '2026-09-10T10:03:00.000Z',
    signer: { id: 'safety-1', role: 'child_safety' },
    capabilityVersionId: id,
  });
  return { ...evaluated, qualification };
}

async function generallyReleasedCapability(
  qualityControl: QualityControlService,
  id = 'generation-v2',
  registerPolicy = true,
) {
  const signed = await signedCapability(qualityControl, id, registerPolicy);
  let record = await qualityControl.advanceRollout({
    allowedUseSlices: [generatedLearningUseSlice],
    capabilityVersionId: id,
    changedAt: '2026-09-10T11:00:00.000Z',
    commandId: `rollout-shadow-${id}`,
    expectedRevision: signed.qualification.revision,
    percentage: 0,
    stage: 'shadow',
  });
  record = await qualityControl.advanceRollout({
    allowedUseSlices: [generatedLearningUseSlice],
    capabilityVersionId: id,
    changedAt: '2026-09-10T12:00:00.000Z',
    commandId: `rollout-small-${id}`,
    expectedRevision: record.revision,
    percentage: 10,
    stage: 'small',
  });
  record = await qualityControl.advanceRollout({
    allowedUseSlices: [generatedLearningUseSlice],
    capabilityVersionId: id,
    changedAt: '2026-09-10T13:00:00.000Z',
    commandId: `rollout-expanded-${id}`,
    expectedRevision: record.revision,
    percentage: 50,
    stage: 'expanded',
  });
  return qualityControl.advanceRollout({
    allowedUseSlices: [generatedLearningUseSlice],
    capabilityVersionId: id,
    changedAt: '2026-09-10T14:00:00.000Z',
    commandId: `rollout-general-${id}`,
    expectedRevision: record.revision,
    percentage: 100,
    stage: 'general',
  });
}

describe('quality control', () => {
  it('registers a complete immutable AI capability version and makes command replay harmless', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    await qualityControl.registerSlicePolicy({
      commandId: 'policy-for-registration',
      policy: slicePolicy,
    });
    const input = {
      commandId: 'register-generation-v2',
      version: capability(),
    };

    const registered = await qualityControl.registerCapability(input);
    (input.version.provider as { id: string }).id = 'tampered-provider';
    const replay = await qualityControl.registerCapability({
      ...input,
      version: { ...registered.version, provider: { ...registered.version.provider } },
    });

    expect(registered).toMatchObject({ revision: 0, version: { id: 'generation-v2' } });
    expect(replay).toEqual(registered);
    expect((await qualityControl.getCapability('generation-v2')).version.provider.id).toBe(
      'bailian',
    );
  });

  it('fails the quality card closed for missing, failed, or undersized required slices', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    await qualityControl.registerSlicePolicy({ commandId: 'policy-v1', policy: slicePolicy });
    await qualityControl.registerCapability({
      commandId: 'register-generation-v2',
      version: capability(),
    });

    const undersized = await qualityControl.recordEvaluation({
      commandId: 'evaluation-small',
      expectedRevision: 0,
      run: {
        capabilityVersionId: 'generation-v2',
        completedAt: '2026-09-10T09:00:00.000Z',
        evidenceHash: 'b'.repeat(64),
        id: 'run-small',
        metrics: { criticalErrorCount: 0, passRate: 1 },
        outcome: 'passed',
        policyVersion: slicePolicy.version,
        sampleSize: 19,
        slice: requiredSlices[0],
      },
    });
    const failed = await qualityControl.recordEvaluation({
      commandId: 'evaluation-failed',
      expectedRevision: undersized.revision,
      run: {
        capabilityVersionId: 'generation-v2',
        completedAt: '2026-09-10T09:05:00.000Z',
        evidenceHash: 'c'.repeat(64),
        id: 'run-failed',
        metrics: { criticalErrorCount: 1, passRate: 0.99 },
        outcome: 'failed',
        policyVersion: slicePolicy.version,
        sampleSize: 2_000,
        slice: requiredSlices[1],
      },
    });
    const card = await qualityControl.getQualityCard('generation-v2');

    expect(failed.revision).toBe(2);
    expect(card.status).toBe('failed');
    expect(card.slices.map(({ status }) => status)).toEqual([
      'insufficient_evidence',
      'failed',
      'missing',
      'missing',
      'missing',
    ]);
  });

  it('rejects a required slice policy that omits learning-basis states', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());

    await expect(
      qualityControl.registerSlicePolicy({
        commandId: 'policy-without-basis-coverage',
        policy: {
          ...slicePolicy,
          requiredSlices: slicePolicy.requiredSlices.map((slice) => ({
            ...slice,
            basisState: 'current',
          })),
          version: 'quality-policy-without-basis-coverage',
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('requires evidence-bound, separated signoffs before qualification', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    const evaluated = await evaluatedCapability(qualityControl);

    expect(evaluated.card.status).toBe('passed');
    await expect(
      qualityControl.signOffCapability({
        commandId: 'implementer-signoff',
        evidenceHash: evaluated.card.evidenceHash,
        expectedRevision: evaluated.record.revision,
        policyVersion: slicePolicy.version,
        signedAt: '2026-09-10T10:00:00.000Z',
        signer: { id: 'engineer-1', role: 'quality_owner' },
        capabilityVersionId: 'generation-v2',
      }),
    ).rejects.toMatchObject({ code: 'SIGNOFF_DENIED' });

    let qualification = await qualityControl.signOffCapability({
      commandId: 'quality-signoff',
      evidenceHash: evaluated.card.evidenceHash,
      expectedRevision: evaluated.record.revision,
      policyVersion: slicePolicy.version,
      signedAt: '2026-09-10T10:01:00.000Z',
      signer: { id: 'quality-1', role: 'quality_owner' },
      capabilityVersionId: 'generation-v2',
    });
    expect(qualification.status).toBe('pending');
    qualification = await qualityControl.signOffCapability({
      commandId: 'domain-signoff',
      evidenceHash: evaluated.card.evidenceHash,
      expectedRevision: qualification.revision,
      policyVersion: slicePolicy.version,
      signedAt: '2026-09-10T10:02:00.000Z',
      signer: { id: 'domain-1', role: 'domain_reviewer' },
      capabilityVersionId: 'generation-v2',
    });
    qualification = await qualityControl.signOffCapability({
      commandId: 'safety-signoff',
      evidenceHash: evaluated.card.evidenceHash,
      expectedRevision: qualification.revision,
      policyVersion: slicePolicy.version,
      signedAt: '2026-09-10T10:03:00.000Z',
      signer: { id: 'safety-1', role: 'child_safety' },
      capabilityVersionId: 'generation-v2',
    });

    expect(qualification).toMatchObject({
      capabilityVersionId: 'generation-v2',
      evidenceHash: evaluated.card.evidenceHash,
      policyVersion: slicePolicy.version,
      revision: evaluated.record.revision + 3,
      status: 'signed',
    });
  });

  it('keeps shadow non-primary and uses a stable family bucket for strict rollout stages', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    const signed = await signedCapability(qualityControl);
    const shadow = await qualityControl.advanceRollout({
      allowedUseSlices: [generatedLearningUseSlice],
      capabilityVersionId: 'generation-v2',
      changedAt: '2026-09-10T11:00:00.000Z',
      commandId: 'rollout-shadow',
      expectedRevision: signed.qualification.revision,
      percentage: 0,
      stage: 'shadow',
    });
    const shadowDecision = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-6',
      kind: 'ai',
      slice: generatedLearningUseSlice,
    });

    expect(shadowDecision).toMatchObject({
      degradedReason: 'OUTSIDE_ROLLOUT',
      primary: null,
      shadow: { capabilityVersion: { id: 'generation-v2' }, rolloutStage: 'shadow' },
      status: 'degraded',
    });
    await expect(
      qualityControl.revalidateAuthorization({
        decisionId: shadowDecision.decisionId,
        expectedContainmentEpoch: shadowDecision.containmentEpoch,
        phase: 'before_send',
        route: 'shadow',
      }),
    ).resolves.toMatchObject({ status: 'authorized' });
    await expect(
      qualityControl.revalidateAuthorization({
        decisionId: shadowDecision.decisionId,
        expectedContainmentEpoch: shadowDecision.containmentEpoch,
        phase: 'before_publish',
        route: 'shadow',
      }),
    ).resolves.toMatchObject({ reason: 'SHADOW_PUBLICATION_FORBIDDEN', status: 'rejected' });

    await qualityControl.advanceRollout({
      allowedUseSlices: [generatedLearningUseSlice],
      capabilityVersionId: 'generation-v2',
      changedAt: '2026-09-10T12:00:00.000Z',
      commandId: 'rollout-small',
      expectedRevision: shadow.revision,
      percentage: 10,
      stage: 'small',
    });
    const first = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-6',
      kind: 'ai',
      slice: generatedLearningUseSlice,
    });
    const replay = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-6',
      kind: 'ai',
      slice: generatedLearningUseSlice,
    });
    const outside = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-1',
      kind: 'ai',
      slice: generatedLearningUseSlice,
    });

    expect(first).toMatchObject({
      primary: { capabilityVersion: { id: 'generation-v2' }, rolloutStage: 'small' },
      rolloutBucket: 6,
      status: 'authorized',
    });
    expect(replay.rolloutBucket).toBe(first.rolloutBucket);
    expect(outside).toMatchObject({
      degradedReason: 'OUTSIDE_ROLLOUT',
      primary: null,
      rolloutBucket: 63,
      status: 'degraded',
    });
  });

  it('invalidates stale authorization and rolls back only to an older signed applicable version', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    await generallyReleasedCapability(qualityControl, 'generation-v1');
    await generallyReleasedCapability(qualityControl, 'generation-v2', false);
    const request = {
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-1',
      kind: 'ai' as const,
      slice: generatedLearningUseSlice,
    };
    const before = await qualityControl.authorizeCapability(request);

    expect(before.primary?.capabilityVersion.id).toBe('generation-v2');
    const after = await qualityControl.rollbackCapability({
      authorization: request,
      commandId: 'rollback-generation-v2',
      containedAt: '2026-09-10T15:00:00.000Z',
      expectedContainmentEpoch: before.containmentEpoch,
      failedCapabilityVersionId: 'generation-v2',
      reason: 'critical-error-threshold-exceeded',
    });
    const stale = await qualityControl.revalidateAuthorization({
      decisionId: before.decisionId,
      expectedContainmentEpoch: before.containmentEpoch,
      phase: 'before_publish',
      route: 'primary',
    });

    expect(after).toMatchObject({
      containmentEpoch: 1,
      primary: { capabilityVersion: { id: 'generation-v1' } },
      status: 'authorized',
    });
    expect(stale).toMatchObject({
      containmentEpoch: 1,
      reason: 'CAPABILITY_CONTAINED',
      status: 'rejected',
    });

    await qualityControl.containCapability({
      commandId: 'contain-bailian',
      containedAt: '2026-09-10T16:00:00.000Z',
      expectedContainmentEpoch: 1,
      reason: 'provider-incident',
      target: { id: 'bailian', kind: 'provider' },
    });
    await expect(qualityControl.authorizeCapability(request)).resolves.toMatchObject({
      containmentEpoch: 2,
      degradedReason: 'CAPABILITY_CONTAINED',
      primary: null,
      status: 'degraded',
    });
  });

  it('records idempotent shadow observations as hashes and metrics without content', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    const signed = await signedCapability(qualityControl);
    await qualityControl.advanceRollout({
      allowedUseSlices: [generatedLearningUseSlice],
      capabilityVersionId: 'generation-v2',
      changedAt: '2026-09-10T11:00:00.000Z',
      commandId: 'shadow-release-for-observation',
      expectedRevision: signed.qualification.revision,
      percentage: 0,
      stage: 'shadow',
    });
    const decision = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-1',
      kind: 'ai',
      slice: generatedLearningUseSlice,
    });
    const input = {
      capabilityVersionId: 'generation-v2',
      commandId: 'shadow-observation-1',
      decisionId: decision.decisionId,
      inputHash: 'd'.repeat(64),
      metrics: { criticalErrorCount: 0, latencyMs: 420 },
      observedAt: '2026-09-10T11:05:00.000Z',
      outputHash: 'e'.repeat(64),
    };

    const observation = await qualityControl.recordShadowObservation(input);
    const replay = await qualityControl.recordShadowObservation(input);

    expect(replay).toEqual(observation);
    expect(observation).toMatchObject({
      capabilityVersionId: 'generation-v2',
      decisionId: decision.decisionId,
      inputHash: input.inputHash,
      metrics: input.metrics,
      outputHash: input.outputHash,
    });
    expect(observation).not.toHaveProperty('body');
    await expect(
      qualityControl.recordShadowObservation({ ...input, body: 'student answer' } as never),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('retries authorization selection when its atomic persistence guard conflicts', async () => {
    const store = new MemoryQualityControlStore();
    const save = store.saveAuthorizationDecision.bind(store);
    let attempts = 0;
    store.saveAuthorizationDecision = async (...args) => {
      attempts += 1;
      if (attempts === 1) return 'conflict' as never;
      return save(...args);
    };
    const qualityControl = new QualityControlService(store);
    await generallyReleasedCapability(qualityControl);

    const decision = await qualityControl.authorizeCapability({
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-1',
      kind: 'ai',
      slice: generatedLearningUseSlice,
    });
    const revalidation = await qualityControl.revalidateAuthorization({
      decisionId: decision.decisionId,
      expectedContainmentEpoch: decision.containmentEpoch,
      phase: 'before_send',
      route: 'primary',
    });

    expect(attempts).toBe(2);
    expect(revalidation.status).toBe('authorized');
  });

  it('fails closed on skipped rollout stages and degrades when rollback has no signed fallback', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    const signed = await signedCapability(qualityControl);

    await expect(
      qualityControl.advanceRollout({
        allowedUseSlices: [generatedLearningUseSlice],
        capabilityVersionId: 'generation-v2',
        changedAt: '2026-09-10T11:00:00.000Z',
        commandId: 'skip-shadow',
        expectedRevision: signed.qualification.revision,
        percentage: 10,
        stage: 'small',
      }),
    ).rejects.toMatchObject({ code: 'ROLLOUT_INVALID' });

    const isolatedQualityControl = new QualityControlService(new MemoryQualityControlStore());
    await generallyReleasedCapability(isolatedQualityControl);
    const authorization = {
      capabilityKey: 'ai.generated-learning',
      familySpaceId: 'family-1',
      kind: 'ai' as const,
      slice: generatedLearningUseSlice,
    };
    const before = await isolatedQualityControl.authorizeCapability(authorization);
    const after = await isolatedQualityControl.rollbackCapability({
      authorization,
      commandId: 'rollback-without-fallback',
      containedAt: '2026-09-10T15:00:00.000Z',
      expectedContainmentEpoch: before.containmentEpoch,
      failedCapabilityVersionId: 'generation-v2',
      reason: 'critical-error-threshold-exceeded',
    });

    expect(after).toMatchObject({
      degradedReason: 'CAPABILITY_CONTAINED',
      primary: null,
      status: 'degraded',
    });
  });

  it('degrades instead of throwing when a registered version lacks its quality policy', async () => {
    const store = new MemoryQualityControlStore();
    const version = capability();
    await store.createCapability(
      {
        evaluationRuns: [],
        revision: 0,
        rollout: {
          allowedUseSlices: [],
          percentage: 0,
          stage: 'disabled',
          updatedAt: version.registeredAt,
        },
        signoffs: [],
        version,
      },
      {
        aggregateId: version.id,
        commandId: 'inject-corrupt-version',
        fingerprint: 'f'.repeat(64),
      },
    );
    const qualityControl = new QualityControlService(store);

    await expect(
      qualityControl.registerCapability({
        commandId: 'register-with-missing-policy',
        version: capability('another-generation-v2'),
      }),
    ).rejects.toMatchObject({
      code: 'SLICE_POLICY_NOT_FOUND',
    });

    await expect(
      qualityControl.authorizeCapability({
        capabilityKey: 'ai.generated-learning',
        familySpaceId: 'family-1',
        kind: 'ai',
        slice: generatedLearningUseSlice,
      }),
    ).resolves.toMatchObject({
      degradedReason: 'NO_SIGNED_CAPABILITY',
      primary: null,
      status: 'degraded',
    });
  });

  it('rejects out-of-order evidence that could replace a newer required-slice result', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    await qualityControl.registerSlicePolicy({ commandId: 'ordered-policy', policy: slicePolicy });
    await qualityControl.registerCapability({
      commandId: 'ordered-capability',
      version: capability(),
    });
    await qualityControl.recordEvaluation({
      commandId: 'newer-evaluation',
      expectedRevision: 0,
      run: {
        capabilityVersionId: 'generation-v2',
        completedAt: '2026-09-10T10:00:00.000Z',
        evidenceHash: '1'.repeat(64),
        id: 'newer-run',
        metrics: { passRate: 1 },
        outcome: 'passed',
        policyVersion: slicePolicy.version,
        sampleSize: 100,
        slice: requiredSlices[0],
      },
    });

    await expect(
      qualityControl.recordEvaluation({
        commandId: 'older-evaluation',
        expectedRevision: 1,
        run: {
          capabilityVersionId: 'generation-v2',
          completedAt: '2026-09-10T09:00:00.000Z',
          evidenceHash: '2'.repeat(64),
          id: 'older-run',
          metrics: { passRate: 1 },
          outcome: 'passed',
          policyVersion: slicePolicy.version,
          sampleSize: 100,
          slice: requiredSlices[0],
        },
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('allows at most one shadow route per capability family', async () => {
    const qualityControl = new QualityControlService(new MemoryQualityControlStore());
    const first = await signedCapability(qualityControl, 'generation-v1');
    const second = await signedCapability(qualityControl, 'generation-v2', false);
    await qualityControl.advanceRollout({
      allowedUseSlices: [generatedLearningUseSlice],
      capabilityVersionId: 'generation-v1',
      changedAt: '2026-09-10T11:00:00.000Z',
      commandId: 'first-shadow',
      expectedRevision: first.qualification.revision,
      percentage: 0,
      stage: 'shadow',
    });

    await expect(
      qualityControl.advanceRollout({
        allowedUseSlices: [generatedLearningUseSlice],
        capabilityVersionId: 'generation-v2',
        changedAt: '2026-09-10T11:01:00.000Z',
        commandId: 'second-shadow',
        expectedRevision: second.qualification.revision,
        percentage: 0,
        stage: 'shadow',
      }),
    ).rejects.toMatchObject({ code: 'ROLLOUT_INVALID' });
  });
});
