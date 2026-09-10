import { createHash } from 'node:crypto';

import type {
  CapabilityQualification,
  CapabilityRecord,
  EvaluationSlice,
  QualityCard,
  RequiredSlicePolicy,
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

export function buildCapabilityQualification(
  record: CapabilityRecord,
  policy: RequiredSlicePolicy,
): CapabilityQualification {
  const card = buildQualityCard(record, policy);
  const signoffs = record.signoffs.filter(
    (signoff) =>
      signoff.evidenceHash === card.evidenceHash && signoff.policyVersion === card.policyVersion,
  );
  const signedRoles = new Set(signoffs.map(({ signer }) => signer.role));
  return {
    capabilityVersionId: record.version.id,
    evidenceHash: card.evidenceHash,
    policyVersion: card.policyVersion,
    revision: record.revision,
    signoffs: structuredClone(signoffs),
    status:
      card.status === 'passed' && policy.requiredSignoffRoles.every((role) => signedRoles.has(role))
        ? 'signed'
        : 'pending',
  };
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function evaluationSliceKey(slice: EvaluationSlice): string {
  return [
    slice.subject,
    slice.gradeBand,
    slice.questionType,
    slice.imageQuality,
    slice.riskLevel,
    slice.basisState,
  ].join(':');
}

export function buildQualityCard(
  record: CapabilityRecord,
  policy: RequiredSlicePolicy,
): QualityCard {
  const slices = policy.requiredSlices.map((slice) => {
    const run = record.evaluationRuns
      .filter(
        (candidate) =>
          candidate.policyVersion === policy.version &&
          evaluationSliceKey(candidate.slice) === evaluationSliceKey(slice),
      )
      .sort(
        (left, right) =>
          right.completedAt.localeCompare(left.completedAt) || right.id.localeCompare(left.id),
      )[0];
    const status = !run
      ? ('missing' as const)
      : run.sampleSize < policy.minimumSampleSize
        ? ('insufficient_evidence' as const)
        : run.outcome === 'failed'
          ? ('failed' as const)
          : ('passed' as const);
    return {
      evaluationEvidenceHash: run?.evidenceHash ?? null,
      evaluationRunId: run?.id ?? null,
      slice: structuredClone(slice),
      status,
    };
  });
  const status = slices.some((slice) => slice.status === 'failed')
    ? ('failed' as const)
    : slices.every((slice) => slice.status === 'passed')
      ? ('passed' as const)
      : ('incomplete' as const);
  return {
    capabilityVersionId: record.version.id,
    evidenceHash: hash({
      capabilityVersionId: record.version.id,
      policyVersion: policy.version,
      slices,
    }),
    policyVersion: policy.version,
    slices,
    status,
  };
}
