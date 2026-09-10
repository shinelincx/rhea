import { createHash, randomUUID } from 'node:crypto';

import { QualityControlError } from './error.js';
import {
  buildCapabilityQualification,
  buildQualityCard,
  evaluationSliceKey,
} from './quality-card.js';
import type { QualityControlStore } from './store.js';
import {
  QUALITY_GRADE_BANDS,
  QUALITY_BASIS_STATES,
  QUALITY_IMAGE_QUALITIES,
  QUALITY_QUESTION_TYPES,
  QUALITY_RISK_LEVELS,
  QUALITY_SUBJECTS,
  type CapabilityRecord,
  type CapabilityKind,
  type CapabilityQualification,
  type CapabilityUseSlice,
  type CapabilityVersion,
  type AuthorizationDecision,
  type AuthorizeCapabilityInput,
  type AdvanceRolloutInput,
  type ContainCapabilityInput,
  type ContainmentOrder,
  type ContainmentState,
  type ContainmentTarget,
  type EvaluationRun,
  type QualityCard,
  type QualityCommand,
  type ReleaseSignoff,
  type RequiredSlicePolicy,
  type RevalidateAuthorizationInput,
  type AuthorizationRevalidation,
  type RolloutStage,
  type RollbackCapabilityInput,
  type RecordShadowObservationInput,
  type ShadowObservation,
} from './types.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function requiredText(value: string, name: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new QualityControlError('INPUT_INVALID', `${name} is required`);
  }
  return normalized;
}

function requireVersion(input: CapabilityVersion): CapabilityVersion {
  if (!/^[a-f0-9]{64}$/.test(input.artifactHash)) {
    throw new QualityControlError('INPUT_INVALID', 'artifactHash must be a SHA-256 hex digest');
  }
  if (Number.isNaN(Date.parse(input.registeredAt))) {
    throw new QualityControlError('INPUT_INVALID', 'registeredAt must be an ISO timestamp');
  }
  if (
    (input.kind !== 'ai' && input.kind !== 'ocr') ||
    (input.kind === 'ai' && input.promptOrConfig.kind !== 'prompt') ||
    (input.kind === 'ocr' && input.promptOrConfig.kind !== 'config')
  ) {
    throw new QualityControlError('INPUT_INVALID', 'capability kind and prompt/config must agree');
  }
  return {
    adapter: {
      id: requiredText(input.adapter.id, 'adapter.id'),
      version: requiredText(input.adapter.version, 'adapter.version'),
    },
    artifactHash: input.artifactHash,
    capabilityKey: requiredText(input.capabilityKey, 'capabilityKey'),
    id: requiredText(input.id, 'id'),
    implementedBy: requiredText(input.implementedBy, 'implementedBy'),
    kind: input.kind,
    modelOrEngine: {
      id: requiredText(input.modelOrEngine.id, 'modelOrEngine.id'),
      version: requiredText(input.modelOrEngine.version, 'modelOrEngine.version'),
    },
    policyVersion: requiredText(input.policyVersion, 'policyVersion'),
    promptOrConfig: {
      kind: input.promptOrConfig.kind,
      version: requiredText(input.promptOrConfig.version, 'promptOrConfig.version'),
    },
    provider: {
      id: requiredText(input.provider.id, 'provider.id'),
      version: requiredText(input.provider.version, 'provider.version'),
    },
    region: requiredText(input.region, 'region'),
    registeredAt: new Date(input.registeredAt).toISOString(),
    requiredSlicePolicyVersion: requiredText(
      input.requiredSlicePolicyVersion,
      'requiredSlicePolicyVersion',
    ),
    templateVersion: requiredText(input.templateVersion, 'templateVersion'),
  };
}

function requireCapabilityKind(value: CapabilityKind): CapabilityKind {
  if (value !== 'ai' && value !== 'ocr') {
    throw new QualityControlError('INPUT_INVALID', 'Capability kind is invalid');
  }
  return value;
}

function requireDigest(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new QualityControlError('INPUT_INVALID', `${name} must be a SHA-256 hex digest`);
  }
  return value;
}

function covers<Value extends string>(
  actual: readonly Value[],
  required: readonly Value[],
): boolean {
  const values = new Set(actual);
  return required.every((value) => values.has(value));
}

function requireSlicePolicy(input: RequiredSlicePolicy): RequiredSlicePolicy {
  const signoffRoles = new Set(input.requiredSignoffRoles);
  const slicesAreValid = input.requiredSlices.every(
    (slice) =>
      (QUALITY_SUBJECTS as readonly string[]).includes(slice.subject) &&
      (QUALITY_GRADE_BANDS as readonly string[]).includes(slice.gradeBand) &&
      (QUALITY_QUESTION_TYPES as readonly string[]).includes(slice.questionType) &&
      (QUALITY_IMAGE_QUALITIES as readonly string[]).includes(slice.imageQuality) &&
      (QUALITY_RISK_LEVELS as readonly string[]).includes(slice.riskLevel) &&
      (QUALITY_BASIS_STATES as readonly string[]).includes(slice.basisState),
  );
  const rolesAreValid = input.requiredSignoffRoles.every((role) =>
    ['child_safety', 'compliance', 'domain_reviewer', 'quality_owner'].includes(role),
  );
  if (
    !Number.isSafeInteger(input.minimumSampleSize) ||
    input.minimumSampleSize < 1 ||
    Number.isNaN(Date.parse(input.registeredAt)) ||
    input.requiredSlices.length === 0 ||
    !slicesAreValid ||
    !rolesAreValid ||
    new Set(input.requiredSlices.map(evaluationSliceKey)).size !== input.requiredSlices.length ||
    !covers(
      input.requiredSlices.map(({ subject }) => subject),
      QUALITY_SUBJECTS,
    ) ||
    !covers(
      input.requiredSlices.map(({ gradeBand }) => gradeBand),
      QUALITY_GRADE_BANDS,
    ) ||
    !covers(
      input.requiredSlices.map(({ questionType }) => questionType),
      QUALITY_QUESTION_TYPES,
    ) ||
    !covers(
      input.requiredSlices.map(({ imageQuality }) => imageQuality),
      QUALITY_IMAGE_QUALITIES,
    ) ||
    !covers(
      input.requiredSlices.map(({ riskLevel }) => riskLevel),
      QUALITY_RISK_LEVELS,
    ) ||
    !covers(
      input.requiredSlices.map(({ basisState }) => basisState),
      QUALITY_BASIS_STATES,
    ) ||
    !signoffRoles.has('quality_owner') ||
    !signoffRoles.has('domain_reviewer') ||
    (!signoffRoles.has('child_safety') && !signoffRoles.has('compliance'))
  ) {
    throw new QualityControlError('INPUT_INVALID', 'Required slice policy is incomplete');
  }
  return {
    minimumSampleSize: input.minimumSampleSize,
    registeredAt: new Date(input.registeredAt).toISOString(),
    requiredSignoffRoles: [...new Set(input.requiredSignoffRoles)],
    requiredSlices: structuredClone(input.requiredSlices),
    version: requiredText(input.version, 'slicePolicy.version'),
  };
}

function requireTimestamp(value: string, name: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new QualityControlError('INPUT_INVALID', `${name} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function useSliceKey(slice: CapabilityUseSlice): string {
  return [
    slice.subject,
    slice.gradeBand,
    slice.questionType,
    slice.imageQuality,
    slice.riskLevel,
    slice.basisState,
  ].join(':');
}

function requireUseSlice(input: CapabilityUseSlice): CapabilityUseSlice {
  const allowed =
    (QUALITY_SUBJECTS as readonly string[]).includes(input.subject) ||
    input.subject === 'unclassified';
  const gradeAllowed =
    (QUALITY_GRADE_BANDS as readonly string[]).includes(input.gradeBand) ||
    input.gradeBand === 'unclassified';
  const questionAllowed =
    (QUALITY_QUESTION_TYPES as readonly string[]).includes(input.questionType) ||
    input.questionType === 'unclassified';
  const imageAllowed =
    (QUALITY_IMAGE_QUALITIES as readonly string[]).includes(input.imageQuality) ||
    input.imageQuality === 'not_applicable' ||
    input.imageQuality === 'unclassified';
  const riskAllowed =
    (QUALITY_RISK_LEVELS as readonly string[]).includes(input.riskLevel) ||
    input.riskLevel === 'unclassified';
  const basisAllowed =
    (QUALITY_BASIS_STATES as readonly string[]).includes(input.basisState) ||
    input.basisState === 'not_applicable' ||
    input.basisState === 'unclassified';
  if (
    !allowed ||
    !gradeAllowed ||
    !questionAllowed ||
    !imageAllowed ||
    !riskAllowed ||
    !basisAllowed
  ) {
    throw new QualityControlError('INPUT_INVALID', 'Capability use slice is invalid');
  }
  return structuredClone(input);
}

const nextRolloutStage: Record<RolloutStage, RolloutStage | null> = {
  disabled: 'shadow',
  expanded: 'general',
  general: null,
  shadow: 'small',
  small: 'expanded',
};

function validRolloutPercentage(stage: RolloutStage, percentage: number): boolean {
  if (!Number.isSafeInteger(percentage)) return false;
  if (stage === 'disabled' || stage === 'shadow') return percentage === 0;
  if (stage === 'small') return percentage >= 1 && percentage <= 10;
  if (stage === 'expanded') return percentage >= 11 && percentage <= 99;
  return percentage === 100;
}

function rolloutBucket(familySpaceId: string): number {
  return (
    Number.parseInt(createHash('sha256').update(familySpaceId).digest('hex').slice(0, 8), 16) % 100
  );
}

function familySpaceHash(familySpaceId: string): string {
  return createHash('sha256').update(familySpaceId).digest('hex');
}

function requireAuthorizationInput(input: AuthorizeCapabilityInput): AuthorizeCapabilityInput {
  const familySpaceId = requiredText(input.familySpaceId, 'familySpaceId');
  return {
    capabilityKey: requiredText(input.capabilityKey, 'capabilityKey'),
    familySpaceId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      familySpaceId,
    )
      ? familySpaceId.toLowerCase()
      : familySpaceId,
    kind: requireCapabilityKind(input.kind),
    slice: requireUseSlice(input.slice),
  };
}

function requireContainmentTarget(input: ContainmentTarget): ContainmentTarget {
  if (input.kind !== 'capability_version' && input.kind !== 'provider') {
    throw new QualityControlError('INPUT_INVALID', 'Containment target kind is invalid');
  }
  return { id: requiredText(input.id, 'target.id'), kind: input.kind };
}

function isContained(record: CapabilityRecord, state: ContainmentState): boolean {
  return state.orders.some(
    ({ target }) =>
      (target.kind === 'capability_version' && target.id === record.version.id) ||
      (target.kind === 'provider' && target.id === record.version.provider.id),
  );
}

const shadowObservationKeys = [
  'capabilityVersionId',
  'commandId',
  'decisionId',
  'inputHash',
  'metrics',
  'observedAt',
  'outputHash',
] as const;

function requireEvaluationRun(input: EvaluationRun): EvaluationRun {
  if (
    !Number.isSafeInteger(input.sampleSize) ||
    input.sampleSize < 0 ||
    Number.isNaN(Date.parse(input.completedAt)) ||
    Object.keys(input.metrics).length === 0 ||
    Object.values(input.metrics).some((value) => !Number.isFinite(value)) ||
    (input.outcome !== 'failed' && input.outcome !== 'passed')
  ) {
    throw new QualityControlError('INPUT_INVALID', 'Evaluation run is invalid');
  }
  return {
    capabilityVersionId: requiredText(input.capabilityVersionId, 'capabilityVersionId'),
    completedAt: new Date(input.completedAt).toISOString(),
    evidenceHash: requireDigest(input.evidenceHash, 'evidenceHash'),
    id: requiredText(input.id, 'evaluationRun.id'),
    metrics: { ...input.metrics },
    outcome: input.outcome,
    policyVersion: requiredText(input.policyVersion, 'policyVersion'),
    sampleSize: input.sampleSize,
    slice: structuredClone(input.slice),
  };
}

export class QualityControlService {
  constructor(private readonly store: QualityControlStore) {}

  async getCapability(id: string): Promise<CapabilityRecord> {
    const record = await this.store.findCapability(requiredText(id, 'capabilityVersionId'));
    if (!record) {
      throw new QualityControlError('CAPABILITY_NOT_FOUND', 'Capability version was not found');
    }
    return record;
  }

  async getQualityCard(capabilityVersionId: string): Promise<QualityCard> {
    const record = await this.getCapability(capabilityVersionId);
    const policy = await this.store.findSlicePolicy(record.version.requiredSlicePolicyVersion);
    if (!policy) {
      throw new QualityControlError(
        'SLICE_POLICY_NOT_FOUND',
        'Required slice policy was not found',
      );
    }
    return buildQualityCard(record, policy);
  }

  async registerCapability(
    input: QualityCommand & { version: CapabilityVersion },
  ): Promise<CapabilityRecord> {
    const commandId = requiredText(input.commandId, 'commandId');
    const version = requireVersion(input.version);
    const requestFingerprint = fingerprint({ type: 'register-capability', version });
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      return this.getCapability(replay.aggregateId);
    }
    if (!(await this.store.findSlicePolicy(version.requiredSlicePolicyVersion))) {
      throw new QualityControlError(
        'SLICE_POLICY_NOT_FOUND',
        'Required slice policy must be registered first',
      );
    }
    const record = {
      evaluationRuns: [],
      revision: 0,
      rollout: {
        allowedUseSlices: [],
        percentage: 0,
        stage: 'disabled' as const,
        updatedAt: version.registeredAt,
      },
      signoffs: [],
      version,
    };
    const created = await this.store.createCapability(record, {
      aggregateId: version.id,
      commandId,
      fingerprint: requestFingerprint,
    });
    if (created === 'duplicate') return this.registerCapability(input);
    if (created === 'conflict') {
      throw new QualityControlError('VERSION_CONFLICT', 'Capability version already exists');
    }
    return structuredClone(record);
  }

  async registerSlicePolicy(
    input: QualityCommand & { policy: RequiredSlicePolicy },
  ): Promise<RequiredSlicePolicy> {
    const commandId = requiredText(input.commandId, 'commandId');
    const policy = requireSlicePolicy(input.policy);
    const requestFingerprint = fingerprint({ policy, type: 'register-slice-policy' });
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      const stored = await this.store.findSlicePolicy(replay.aggregateId);
      if (!stored) {
        throw new QualityControlError(
          'SLICE_POLICY_NOT_FOUND',
          'Required slice policy was not found',
        );
      }
      return stored;
    }
    const created = await this.store.createSlicePolicy(policy, {
      aggregateId: policy.version,
      commandId,
      fingerprint: requestFingerprint,
    });
    if (created === 'duplicate') return this.registerSlicePolicy(input);
    if (created === 'conflict') {
      throw new QualityControlError('VERSION_CONFLICT', 'Slice policy version already exists');
    }
    return structuredClone(policy);
  }

  async recordEvaluation(
    input: QualityCommand & { expectedRevision: number; run: EvaluationRun },
  ): Promise<CapabilityRecord> {
    const commandId = requiredText(input.commandId, 'commandId');
    const run = requireEvaluationRun(input.run);
    const requestFingerprint = fingerprint({ run, type: 'record-evaluation' });
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      return this.getCapability(replay.aggregateId);
    }
    const record = await this.getCapability(run.capabilityVersionId);
    const policy = await this.store.findSlicePolicy(record.version.requiredSlicePolicyVersion);
    const latestForSlice = record.evaluationRuns
      .filter(
        (existing) =>
          existing.policyVersion === run.policyVersion &&
          evaluationSliceKey(existing.slice) === evaluationSliceKey(run.slice),
      )
      .sort(
        (left, right) =>
          right.completedAt.localeCompare(left.completedAt) || right.id.localeCompare(left.id),
      )[0];
    if (
      !policy ||
      run.policyVersion !== policy.version ||
      !policy.requiredSlices.some(
        (slice) => evaluationSliceKey(slice) === evaluationSliceKey(run.slice),
      ) ||
      (latestForSlice !== undefined && run.completedAt <= latestForSlice.completedAt) ||
      record.evaluationRuns.some(({ id }) => id === run.id)
    ) {
      throw new QualityControlError(
        'INPUT_INVALID',
        'Evaluation does not match the required policy',
      );
    }
    const updated = {
      ...record,
      evaluationRuns: [...record.evaluationRuns, run],
      revision: record.revision + 1,
    };
    const saved = await this.store.saveCapability(
      updated,
      input.expectedRevision,
      {
        aggregateId: record.version.id,
        commandId,
        fingerprint: requestFingerprint,
      },
      'evaluation',
    );
    if (saved === 'duplicate') return this.recordEvaluation(input);
    if (saved === 'conflict') {
      throw new QualityControlError('VERSION_CONFLICT', 'Capability revision has changed');
    }
    return structuredClone(updated);
  }

  async signOffCapability(
    input: QualityCommand & {
      capabilityVersionId: string;
      evidenceHash: string;
      expectedRevision: number;
      policyVersion: string;
      signedAt: string;
      signer: ReleaseSignoff['signer'];
    },
  ): Promise<CapabilityQualification> {
    const commandId = requiredText(input.commandId, 'commandId');
    const capabilityVersionId = requiredText(input.capabilityVersionId, 'capabilityVersionId');
    const signoff: ReleaseSignoff = {
      evidenceHash: requireDigest(input.evidenceHash, 'evidenceHash'),
      policyVersion: requiredText(input.policyVersion, 'policyVersion'),
      signedAt: requireTimestamp(input.signedAt, 'signedAt'),
      signer: {
        id: requiredText(input.signer.id, 'signer.id'),
        role: input.signer.role,
      },
    };
    const requestFingerprint = fingerprint({
      capabilityVersionId,
      signoff,
      type: 'sign-off-capability',
    });
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      return this.#qualification(await this.getCapability(replay.aggregateId));
    }
    const record = await this.getCapability(capabilityVersionId);
    const policy = await this.store.findSlicePolicy(record.version.requiredSlicePolicyVersion);
    if (!policy) {
      throw new QualityControlError(
        'SLICE_POLICY_NOT_FOUND',
        'Required slice policy was not found',
      );
    }
    const card = await this.getQualityCard(capabilityVersionId);
    if (
      card.status !== 'passed' ||
      card.evidenceHash !== signoff.evidenceHash ||
      card.policyVersion !== signoff.policyVersion
    ) {
      throw new QualityControlError('QUALITY_GATE_FAILED', 'Signoff evidence is not current');
    }
    if (
      signoff.signer.id === record.version.implementedBy ||
      !policy.requiredSignoffRoles.includes(signoff.signer.role) ||
      record.signoffs.some(
        (existing) =>
          existing.evidenceHash === card.evidenceHash &&
          (existing.signer.id === signoff.signer.id ||
            existing.signer.role === signoff.signer.role),
      )
    ) {
      throw new QualityControlError('SIGNOFF_DENIED', 'Signoff duties must remain separated');
    }
    const updated = {
      ...record,
      revision: record.revision + 1,
      signoffs: [...record.signoffs, signoff],
    };
    const saved = await this.store.saveCapability(
      updated,
      input.expectedRevision,
      {
        aggregateId: record.version.id,
        commandId,
        fingerprint: requestFingerprint,
      },
      'signoff',
    );
    if (saved === 'duplicate') return this.signOffCapability(input);
    if (saved === 'conflict') {
      throw new QualityControlError('VERSION_CONFLICT', 'Capability revision has changed');
    }
    return this.#qualification(updated);
  }

  async advanceRollout(input: AdvanceRolloutInput): Promise<CapabilityRecord> {
    const commandId = requiredText(input.commandId, 'commandId');
    const capabilityVersionId = requiredText(input.capabilityVersionId, 'capabilityVersionId');
    const allowedUseSlices = input.allowedUseSlices.map(requireUseSlice);
    const changedAt = requireTimestamp(input.changedAt, 'changedAt');
    const requestFingerprint = fingerprint({
      allowedUseSlices,
      capabilityVersionId,
      changedAt,
      percentage: input.percentage,
      stage: input.stage,
      type: 'advance-rollout',
    });
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      return this.getCapability(replay.aggregateId);
    }
    const record = await this.getCapability(capabilityVersionId);
    const qualification = await this.#qualification(record);
    const containment = await this.store.findContainmentState();
    const anotherShadow =
      input.stage === 'shadow' &&
      (await this.store.listCapabilities(record.version.capabilityKey, record.version.kind)).some(
        (candidate) =>
          candidate.version.id !== record.version.id &&
          candidate.rollout.stage === 'shadow' &&
          !isContained(candidate, containment),
      );
    const scopeChanged =
      record.rollout.stage !== 'disabled' &&
      JSON.stringify(record.rollout.allowedUseSlices.map(useSliceKey).sort()) !==
        JSON.stringify(allowedUseSlices.map(useSliceKey).sort());
    if (
      qualification.status !== 'signed' ||
      nextRolloutStage[record.rollout.stage] !== input.stage ||
      !validRolloutPercentage(input.stage, input.percentage) ||
      allowedUseSlices.length === 0 ||
      new Set(allowedUseSlices.map(useSliceKey)).size !== allowedUseSlices.length ||
      scopeChanged ||
      anotherShadow
    ) {
      throw new QualityControlError('ROLLOUT_INVALID', 'Rollout transition is not allowed');
    }
    const updated: CapabilityRecord = {
      ...record,
      revision: record.revision + 1,
      rollout: {
        allowedUseSlices,
        percentage: input.percentage,
        stage: input.stage,
        updatedAt: changedAt,
      },
    };
    const saved = await this.store.saveCapability(
      updated,
      input.expectedRevision,
      {
        aggregateId: capabilityVersionId,
        commandId,
        fingerprint: requestFingerprint,
      },
      'rollout',
    );
    if (saved === 'duplicate') return this.advanceRollout(input);
    if (saved === 'conflict') {
      throw new QualityControlError('VERSION_CONFLICT', 'Capability revision has changed');
    }
    return structuredClone(updated);
  }

  async authorizeCapability(input: AuthorizeCapabilityInput): Promise<AuthorizationDecision> {
    const { capabilityKey, familySpaceId, kind, slice } = requireAuthorizationInput(input);
    const bucket = rolloutBucket(familySpaceId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const records = (await this.store.listCapabilities(capabilityKey, kind)).sort(
        (left, right) =>
          right.version.registeredAt.localeCompare(left.version.registeredAt) ||
          right.version.id.localeCompare(left.version.id),
      );
      const containment = await this.store.findContainmentState();
      const qualified: CapabilityRecord[] = [];
      for (const record of records) {
        const policy = await this.store.findSlicePolicy(record.version.requiredSlicePolicyVersion);
        if (policy && buildCapabilityQualification(record, policy).status === 'signed') {
          qualified.push(record);
        }
      }
      const allApplicable = qualified.filter((record) =>
        record.rollout.allowedUseSlices.some(
          (allowedSlice) => useSliceKey(allowedSlice) === useSliceKey(slice),
        ),
      );
      const applicable = allApplicable.filter((record) => !isContained(record, containment));
      const primaryRecord = applicable.find(
        (record) =>
          record.rollout.stage === 'general' ||
          ((record.rollout.stage === 'small' || record.rollout.stage === 'expanded') &&
            bucket < record.rollout.percentage),
      );
      const shadowRecord = applicable.find((record) => record.rollout.stage === 'shadow');
      const scope = { capabilityKey, kind, slice };
      const primary = primaryRecord
        ? {
            capabilityVersion: primaryRecord.version,
            rolloutStage: primaryRecord.rollout.stage as Exclude<RolloutStage, 'disabled'>,
          }
        : null;
      const shadow = shadowRecord
        ? { capabilityVersion: shadowRecord.version, rolloutStage: 'shadow' as const }
        : null;
      const degradedReason = primary
        ? null
        : records.length === 0
          ? ('NO_APPLICABLE_CAPABILITY' as const)
          : records.some((record) => isContained(record, containment))
            ? ('CAPABILITY_CONTAINED' as const)
            : qualified.length === 0
              ? ('NO_SIGNED_CAPABILITY' as const)
              : applicable.length === 0
                ? ('NO_APPLICABLE_CAPABILITY' as const)
                : ('OUTSIDE_ROLLOUT' as const);
      const decision: AuthorizationDecision = {
        containmentEpoch: containment.epoch,
        decisionId: randomUUID(),
        degradedReason,
        issuedAt: new Date().toISOString(),
        primary,
        rolloutBucket: bucket,
        scope,
        shadow,
        status: primary ? 'authorized' : 'degraded',
      };
      const saved = await this.store.saveAuthorizationDecision(decision, {
        capabilityRevisions: records.map((record) => ({
          id: record.version.id,
          revision: record.revision,
        })),
        containmentEpoch: containment.epoch,
        familySpaceHash: familySpaceHash(familySpaceId),
      });
      if (saved.status === 'saved') return structuredClone(saved.decision);
    }
    throw new QualityControlError(
      'VERSION_CONFLICT',
      'Authorization inputs changed repeatedly; retry the request',
    );
  }

  async revalidateAuthorization(
    input: RevalidateAuthorizationInput,
  ): Promise<AuthorizationRevalidation> {
    const decisionId = requiredText(input.decisionId, 'decisionId');
    return this.store.revalidateAuthorizationAtomically(
      { ...input, decisionId },
      ({ containment, decision, records, slicePolicies }) => {
        if (!decision) {
          return {
            containmentEpoch: containment.epoch,
            decisionId,
            reason: 'AUTHORIZATION_STALE',
            status: 'rejected',
          };
        }
        const authorization = decision[input.route];
        const record = records.find(
          (candidate) => candidate.version.id === authorization?.capabilityVersion.id,
        );
        if (record && isContained(record, containment)) {
          return {
            containmentEpoch: containment.epoch,
            decisionId,
            reason: 'CAPABILITY_CONTAINED',
            status: 'rejected',
          };
        }
        if (
          input.expectedContainmentEpoch !== decision.containmentEpoch ||
          containment.epoch !== decision.containmentEpoch
        ) {
          return {
            containmentEpoch: containment.epoch,
            decisionId,
            reason: 'AUTHORIZATION_STALE',
            status: 'rejected',
          };
        }
        if (input.route === 'shadow' && input.phase === 'before_publish') {
          return {
            containmentEpoch: containment.epoch,
            decisionId,
            reason: 'SHADOW_PUBLICATION_FORBIDDEN',
            status: 'rejected',
          };
        }
        if (!authorization || !record) {
          return {
            containmentEpoch: containment.epoch,
            decisionId,
            reason: 'ROUTE_NOT_AUTHORIZED',
            status: 'rejected',
          };
        }
        const policy = slicePolicies.find(
          (candidate) => candidate.version === record.version.requiredSlicePolicyVersion,
        );
        const routeIsCurrent =
          policy &&
          buildCapabilityQualification(record, policy).status === 'signed' &&
          record.rollout.allowedUseSlices.some(
            (slice) => useSliceKey(slice) === useSliceKey(decision.scope.slice),
          ) &&
          (input.route === 'shadow'
            ? record.rollout.stage === 'shadow'
            : record.rollout.stage === 'general' ||
              ((record.rollout.stage === 'small' || record.rollout.stage === 'expanded') &&
                decision.rolloutBucket < record.rollout.percentage));
        if (!routeIsCurrent) {
          return {
            containmentEpoch: containment.epoch,
            decisionId,
            reason: 'ROUTE_NOT_AUTHORIZED',
            status: 'rejected',
          };
        }
        return {
          capabilityVersion: structuredClone(record.version),
          containmentEpoch: containment.epoch,
          decisionId,
          status: 'authorized',
        };
      },
    );
  }

  async containCapability(input: ContainCapabilityInput): Promise<ContainmentState> {
    return this.#contain(input, 'contain-capability');
  }

  async rollbackCapability(input: RollbackCapabilityInput): Promise<AuthorizationDecision> {
    const failedCapabilityVersionId = requiredText(
      input.failedCapabilityVersionId,
      'failedCapabilityVersionId',
    );
    const containmentInput = {
      commandId: input.commandId,
      containedAt: input.containedAt,
      expectedContainmentEpoch: input.expectedContainmentEpoch,
      reason: input.reason,
      target: { id: failedCapabilityVersionId, kind: 'capability_version' as const },
    };
    const authorization = requireAuthorizationInput(input.authorization);
    const requestFingerprint = fingerprint({
      authorization,
      containment: this.#containmentFingerprint(containmentInput, 'rollback-capability'),
      type: 'rollback-capability',
    });
    const replay = await this.store.findCommand(requiredText(input.commandId, 'commandId'));
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      return this.authorizeCapability(authorization);
    }
    const current = await this.authorizeCapability(authorization);
    if (current.primary?.capabilityVersion.id !== failedCapabilityVersionId) {
      throw new QualityControlError(
        'ROLLBACK_INVALID',
        'Only the currently authorized primary version can be rolled back',
      );
    }
    await this.#contain(containmentInput, 'rollback-capability', requestFingerprint, {
      decisionId: current.decisionId,
      primaryVersionId: failedCapabilityVersionId,
    });
    return this.authorizeCapability(authorization);
  }

  async recordShadowObservation(input: RecordShadowObservationInput): Promise<ShadowObservation> {
    if (
      JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify([...shadowObservationKeys].sort())
    ) {
      throw new QualityControlError(
        'INPUT_INVALID',
        'Shadow observations may contain only hashes and metrics',
      );
    }
    const commandId = requiredText(input.commandId, 'commandId');
    const capabilityVersionId = requiredText(input.capabilityVersionId, 'capabilityVersionId');
    const decisionId = requiredText(input.decisionId, 'decisionId');
    const metrics = Object.fromEntries(
      Object.entries(input.metrics).map(([name, value]) => [
        requiredText(name, 'metric.name'),
        value,
      ]),
    );
    if (
      Object.keys(metrics).length === 0 ||
      Object.values(metrics).some((value) => !Number.isFinite(value))
    ) {
      throw new QualityControlError('INPUT_INVALID', 'Shadow metrics are invalid');
    }
    const observationData = {
      capabilityVersionId,
      decisionId,
      inputHash: requireDigest(input.inputHash, 'inputHash'),
      metrics,
      observedAt: requireTimestamp(input.observedAt, 'observedAt'),
      outputHash: requireDigest(input.outputHash, 'outputHash'),
    };
    const requestFingerprint = fingerprint({ ...observationData, type: 'shadow-observation' });
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      const stored = await this.store.findShadowObservation(replay.aggregateId);
      if (!stored) {
        throw new QualityControlError(
          'SHADOW_OBSERVATION_DENIED',
          'Shadow observation was not found',
        );
      }
      return stored;
    }
    const decision = await this.store.findAuthorizationDecision(decisionId);
    if (decision?.shadow?.capabilityVersion.id !== capabilityVersionId) {
      throw new QualityControlError(
        'SHADOW_OBSERVATION_DENIED',
        'Observation does not match an authorized shadow route',
      );
    }
    const revalidation = await this.revalidateAuthorization({
      decisionId,
      expectedContainmentEpoch: decision.containmentEpoch,
      phase: 'after_receive',
      route: 'shadow',
    });
    if (revalidation.status !== 'authorized') {
      throw new QualityControlError(
        'SHADOW_OBSERVATION_DENIED',
        'Shadow authorization is no longer valid',
      );
    }
    const observation: ShadowObservation = {
      ...observationData,
      id: randomUUID(),
    };
    const created = await this.store.createShadowObservation(observation, {
      aggregateId: observation.id,
      commandId,
      fingerprint: requestFingerprint,
    });
    if (created === 'duplicate') return this.recordShadowObservation(input);
    if (created === 'conflict') return this.recordShadowObservation(input);
    return structuredClone(observation);
  }

  #containmentFingerprint(
    input: ContainCapabilityInput,
    operation: 'contain-capability' | 'rollback-capability',
  ): string {
    return fingerprint({
      containedAt: requireTimestamp(input.containedAt, 'containedAt'),
      reason: requiredText(input.reason, 'reason', 500),
      target: requireContainmentTarget(input.target),
      type: operation,
    });
  }

  async #contain(
    input: ContainCapabilityInput,
    operation: 'contain-capability' | 'rollback-capability',
    fingerprintOverride?: string,
    rollback?: { decisionId: string; primaryVersionId: string },
  ): Promise<ContainmentState> {
    const commandId = requiredText(input.commandId, 'commandId');
    const target = requireContainmentTarget(input.target);
    const containedAt = requireTimestamp(input.containedAt, 'containedAt');
    const reason = requiredText(input.reason, 'reason', 500);
    const requestFingerprint =
      fingerprintOverride ?? this.#containmentFingerprint(input, operation);
    const replay = await this.store.findCommand(commandId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) {
        throw new QualityControlError('INPUT_INVALID', 'Command id cannot be reused');
      }
      return this.store.findContainmentState();
    }
    if (
      !Number.isSafeInteger(input.expectedContainmentEpoch) ||
      input.expectedContainmentEpoch < 0
    ) {
      throw new QualityControlError('INPUT_INVALID', 'Expected containment epoch is invalid');
    }
    const order: ContainmentOrder = {
      containedAt,
      epoch: input.expectedContainmentEpoch + 1,
      id: randomUUID(),
      reason,
      target,
    };
    const saved = await this.store.saveContainmentOrder(
      order,
      {
        containmentEpoch: input.expectedContainmentEpoch,
        ...(rollback ? { rollback } : {}),
      },
      {
        aggregateId: order.id,
        commandId,
        fingerprint: requestFingerprint,
      },
    );
    if (saved === 'duplicate') {
      return this.#contain(input, operation, fingerprintOverride, rollback);
    }
    if (saved === 'conflict') {
      throw new QualityControlError('VERSION_CONFLICT', 'Containment epoch has changed');
    }
    return this.store.findContainmentState();
  }

  async #qualification(record: CapabilityRecord): Promise<CapabilityQualification> {
    const policy = await this.store.findSlicePolicy(record.version.requiredSlicePolicyVersion);
    if (!policy) {
      throw new QualityControlError(
        'SLICE_POLICY_NOT_FOUND',
        'Required slice policy was not found',
      );
    }
    return buildCapabilityQualification(record, policy);
  }
}
