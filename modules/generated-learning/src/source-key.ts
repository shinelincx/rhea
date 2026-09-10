import { createHash } from 'node:crypto';

import type { GenerationSourceSnapshot } from './types.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}

export function stableGeneratedLearningHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function generatedLearningSourceKey(source: GenerationSourceSnapshot): string {
  return [
    'learning_pack',
    'v1',
    source.basis.materialId,
    source.basis.sourceVersionId,
    source.basis.selectionVersion,
    source.basis.validityEpoch,
    source.basis.contentHash,
    source.confirmedContentVersionId,
    source.classificationRevision,
    source.processingJobId,
  ].join(':');
}
