export type QualityControlErrorCode =
  | 'CAPABILITY_NOT_FOUND'
  | 'INPUT_INVALID'
  | 'QUALITY_GATE_FAILED'
  | 'ROLLOUT_INVALID'
  | 'ROLLBACK_INVALID'
  | 'SIGNOFF_DENIED'
  | 'SHADOW_OBSERVATION_DENIED'
  | 'SLICE_POLICY_NOT_FOUND'
  | 'VERSION_CONFLICT';

export class QualityControlError extends Error {
  constructor(
    readonly code: QualityControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QualityControlError';
  }
}
