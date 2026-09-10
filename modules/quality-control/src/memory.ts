import type {
  AuthorizationDecisionGuard,
  AuthorizationDecisionSaveResult,
  AuthorizationRevalidationSnapshot,
  CapabilityMutation,
  ContainmentSaveGuard,
  QualityControlStore,
  QualityCommandReceipt,
} from './store.js';
import { buildCapabilityQualification } from './quality-card.js';
import type {
  AuthorizationDecision,
  CapabilityKind,
  CapabilityRecord,
  ContainmentOrder,
  ContainmentState,
  RequiredSlicePolicy,
  AuthorizationRevalidation,
  RevalidateAuthorizationInput,
  ShadowObservation,
} from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryQualityControlStore implements QualityControlStore {
  readonly #authorizationDecisions = new Map<string, AuthorizationDecision>();
  readonly #capabilities = new Map<string, CapabilityRecord>();
  readonly #commands = new Map<string, QualityCommandReceipt>();
  #containmentState: ContainmentState = { epoch: 0, orders: [] };
  readonly #slicePolicies = new Map<string, RequiredSlicePolicy>();
  readonly #shadowObservations = new Map<string, ShadowObservation>();

  async createCapability(
    record: CapabilityRecord,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'> {
    if (this.#commands.has(receipt.commandId)) return 'duplicate';
    if (this.#capabilities.has(record.version.id)) return 'conflict';
    this.#capabilities.set(record.version.id, clone(record));
    this.#commands.set(receipt.commandId, clone(receipt));
    return 'created';
  }

  async createShadowObservation(
    observation: ShadowObservation,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'> {
    if (this.#commands.has(receipt.commandId)) return 'duplicate';
    if (this.#shadowObservations.has(observation.id)) return 'conflict';
    this.#shadowObservations.set(observation.id, clone(observation));
    this.#commands.set(receipt.commandId, clone(receipt));
    return 'created';
  }

  async findCapability(id: string): Promise<CapabilityRecord | null> {
    const record = this.#capabilities.get(id);
    return record ? clone(record) : null;
  }

  async findAuthorizationDecision(id: string): Promise<AuthorizationDecision | null> {
    const decision = this.#authorizationDecisions.get(id);
    return decision ? clone(decision) : null;
  }

  async findCommand(commandId: string): Promise<QualityCommandReceipt | null> {
    const receipt = this.#commands.get(commandId);
    return receipt ? clone(receipt) : null;
  }

  async findContainmentState(): Promise<ContainmentState> {
    return clone(this.#containmentState);
  }

  async createSlicePolicy(
    policy: RequiredSlicePolicy,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'created' | 'duplicate'> {
    if (this.#commands.has(receipt.commandId)) return 'duplicate';
    if (this.#slicePolicies.has(policy.version)) return 'conflict';
    this.#slicePolicies.set(policy.version, clone(policy));
    this.#commands.set(receipt.commandId, clone(receipt));
    return 'created';
  }

  async findSlicePolicy(version: string): Promise<RequiredSlicePolicy | null> {
    const policy = this.#slicePolicies.get(version);
    return policy ? clone(policy) : null;
  }

  async findShadowObservation(id: string): Promise<ShadowObservation | null> {
    const observation = this.#shadowObservations.get(id);
    return observation ? clone(observation) : null;
  }

  async listCapabilities(capabilityKey: string, kind: CapabilityKind): Promise<CapabilityRecord[]> {
    return [...this.#capabilities.values()]
      .filter(
        (record) => record.version.capabilityKey === capabilityKey && record.version.kind === kind,
      )
      .map(clone);
  }

  async saveAuthorizationDecision(
    decision: AuthorizationDecision,
    guard: AuthorizationDecisionGuard,
  ): Promise<AuthorizationDecisionSaveResult> {
    const currentRevisions = [...this.#capabilities.values()]
      .filter(
        (record) =>
          record.version.capabilityKey === decision.scope.capabilityKey &&
          record.version.kind === decision.scope.kind,
      )
      .map((record) => ({ id: record.version.id, revision: record.revision }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const expectedRevisions = [...guard.capabilityRevisions].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (
      decision.containmentEpoch !== guard.containmentEpoch ||
      this.#containmentState.epoch !== guard.containmentEpoch ||
      JSON.stringify(currentRevisions) !== JSON.stringify(expectedRevisions)
    ) {
      return { status: 'conflict' };
    }
    this.#authorizationDecisions.set(decision.decisionId, clone(decision));
    return { decision: clone(decision), status: 'saved' };
  }

  async saveContainmentOrder(
    order: ContainmentOrder,
    guard: ContainmentSaveGuard,
    receipt: QualityCommandReceipt,
  ): Promise<'conflict' | 'duplicate' | 'saved'> {
    if (this.#commands.has(receipt.commandId)) return 'duplicate';
    const rollbackDecision = guard.rollback
      ? this.#authorizationDecisions.get(guard.rollback.decisionId)
      : null;
    const rollbackRecord = rollbackDecision?.primary
      ? this.#capabilities.get(rollbackDecision.primary.capabilityVersion.id)
      : null;
    const rollbackPolicy = rollbackRecord
      ? this.#slicePolicies.get(rollbackRecord.version.requiredSlicePolicyVersion)
      : null;
    const currentPrimaryVersionId = rollbackDecision
      ? [...this.#capabilities.values()]
          .filter(
            (record) =>
              record.version.capabilityKey === rollbackDecision.scope.capabilityKey &&
              record.version.kind === rollbackDecision.scope.kind,
          )
          .sort(
            (left, right) =>
              right.version.registeredAt.localeCompare(left.version.registeredAt) ||
              right.version.id.localeCompare(left.version.id),
          )
          .find((record) => {
            const policy = this.#slicePolicies.get(record.version.requiredSlicePolicyVersion);
            const contained = this.#containmentState.orders.some(
              ({ target }) =>
                (target.kind === 'capability_version' && target.id === record.version.id) ||
                (target.kind === 'provider' && target.id === record.version.provider.id),
            );
            return (
              policy !== undefined &&
              buildCapabilityQualification(record, policy).status === 'signed' &&
              !contained &&
              record.rollout.allowedUseSlices.some((slice) =>
                isDeepStrictEqual(slice, rollbackDecision.scope.slice),
              ) &&
              (record.rollout.stage === 'general' ||
                ((record.rollout.stage === 'small' || record.rollout.stage === 'expanded') &&
                  rollbackDecision.rolloutBucket < record.rollout.percentage))
            );
          })?.version.id
      : null;
    const rollbackIsCurrent =
      !guard.rollback ||
      (rollbackDecision?.containmentEpoch === guard.containmentEpoch &&
        rollbackDecision.primary?.capabilityVersion.id === guard.rollback.primaryVersionId &&
        currentPrimaryVersionId === guard.rollback.primaryVersionId &&
        rollbackRecord != null &&
        rollbackPolicy != null &&
        buildCapabilityQualification(rollbackRecord, rollbackPolicy).status === 'signed' &&
        rollbackRecord.rollout.allowedUseSlices.some((slice) =>
          isDeepStrictEqual(slice, rollbackDecision.scope.slice),
        ) &&
        (rollbackRecord.rollout.stage === 'general' ||
          ((rollbackRecord.rollout.stage === 'small' ||
            rollbackRecord.rollout.stage === 'expanded') &&
            rollbackDecision.rolloutBucket < rollbackRecord.rollout.percentage)));
    if (
      this.#containmentState.epoch !== guard.containmentEpoch ||
      order.epoch !== guard.containmentEpoch + 1 ||
      !rollbackIsCurrent ||
      this.#containmentState.orders.some(
        ({ target }) => target.kind === order.target.kind && target.id === order.target.id,
      )
    ) {
      return 'conflict';
    }
    this.#containmentState = {
      epoch: order.epoch,
      orders: [...this.#containmentState.orders, clone(order)],
    };
    this.#commands.set(receipt.commandId, clone(receipt));
    return 'saved';
  }

  async revalidateAuthorizationAtomically(
    input: RevalidateAuthorizationInput,
    inspect: (snapshot: AuthorizationRevalidationSnapshot) => AuthorizationRevalidation,
  ): Promise<AuthorizationRevalidation> {
    const decision = this.#authorizationDecisions.get(input.decisionId) ?? null;
    const versionIds = new Set(
      [decision?.primary?.capabilityVersion.id, decision?.shadow?.capabilityVersion.id].filter(
        (id): id is string => Boolean(id),
      ),
    );
    const records = [...versionIds]
      .map((id) => this.#capabilities.get(id))
      .filter((record): record is CapabilityRecord => Boolean(record));
    const policyVersions = new Set(
      records.map(({ version }) => version.requiredSlicePolicyVersion),
    );
    const slicePolicies = [...policyVersions]
      .map((version) => this.#slicePolicies.get(version))
      .filter((policy): policy is RequiredSlicePolicy => Boolean(policy));
    return inspect(
      clone({
        containment: this.#containmentState,
        decision,
        records,
        slicePolicies,
      }),
    );
  }

  async saveCapability(
    record: CapabilityRecord,
    expectedRevision: number,
    receipt: QualityCommandReceipt,
    mutation: CapabilityMutation,
  ): Promise<'conflict' | 'duplicate' | 'saved'> {
    if (this.#commands.has(receipt.commandId)) return 'duplicate';
    const current = this.#capabilities.get(record.version.id);
    const versionChanged =
      current && JSON.stringify(current.version) !== JSON.stringify(record.version);
    const evaluationChanged =
      current && JSON.stringify(current.evaluationRuns) !== JSON.stringify(record.evaluationRuns);
    const signoffChanged =
      current && JSON.stringify(current.signoffs) !== JSON.stringify(record.signoffs);
    const rolloutChanged =
      current && JSON.stringify(current.rollout) !== JSON.stringify(record.rollout);
    const evaluationAppended =
      current &&
      record.evaluationRuns.length === current.evaluationRuns.length + 1 &&
      JSON.stringify(record.evaluationRuns.slice(0, -1)) === JSON.stringify(current.evaluationRuns);
    const signoffAppended =
      current &&
      record.signoffs.length === current.signoffs.length + 1 &&
      JSON.stringify(record.signoffs.slice(0, -1)) === JSON.stringify(current.signoffs);
    const mixedOrWrongMutation =
      !['evaluation', 'rollout', 'signoff'].includes(mutation) ||
      (mutation === 'evaluation' &&
        (!evaluationChanged || !evaluationAppended || signoffChanged || rolloutChanged)) ||
      (mutation === 'signoff' &&
        (evaluationChanged || !signoffChanged || !signoffAppended || rolloutChanged)) ||
      (mutation === 'rollout' && (evaluationChanged || signoffChanged || !rolloutChanged));
    if (
      !current ||
      current.revision !== expectedRevision ||
      record.revision !== expectedRevision + 1 ||
      versionChanged ||
      mixedOrWrongMutation
    ) {
      return 'conflict';
    }
    this.#capabilities.set(record.version.id, clone(record));
    this.#commands.set(receipt.commandId, clone(receipt));
    return 'saved';
  }
}
import { isDeepStrictEqual } from 'node:util';
