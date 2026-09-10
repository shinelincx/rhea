import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  generatedLearningSourceKey,
  type GeneratedLearningCapability,
  type GeneratedLearningContentVersion,
  type GeneratedLearningStore,
  type GenerationCheck,
  type GenerationCompletionResult,
  type GenerationPublicationGate,
  type GenerationRequestStatus,
  type GenerationSourceSnapshot,
  type GenerationUnavailableReason,
  type ModelRunRecord,
  type StoredGenerationRequest,
} from '@rhea/generated-learning';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface RequestRow extends QueryResultRow {
  actor_id: string;
  actor_type: StoredGenerationRequest['actor']['type'];
  authorization: unknown;
  capability: unknown;
  consent_revision: number;
  created_at: Date;
  current_version_id: string | null;
  family_space_id: string;
  id: string;
  idempotency_key: string;
  latest_checks: unknown;
  learning_profile_id: string;
  material_id: string;
  model_runs: unknown;
  processing_lease_expires_at: Date | null;
  purpose: StoredGenerationRequest['purpose'];
  request_fingerprint: string;
  revealed_hint_level: StoredGenerationRequest['revealedHintLevel'];
  source_key: string;
  source_snapshot: unknown;
  state_revision: number;
  status: GenerationRequestStatus;
  unavailable_reason: GenerationUnavailableReason | null;
  updated_at: Date;
}

interface VersionRow extends QueryResultRow {
  authorization: unknown;
  capability: unknown;
  checks: unknown;
  content_state: GeneratedLearningContentVersion['contentState'];
  created_at: Date;
  id: string;
  pack: unknown;
  predecessor_id: string | null;
  revision: number;
  source_snapshot: unknown;
}

const REQUIRED_GENERATION_CHECKS = new Set<GenerationCheck['kind']>([
  'age_appropriateness',
  'answer_leakage',
  'consistency',
  'safety',
  'schema',
  'solvability',
  'source_coverage',
]);

const MODEL_RUN_FIELDS = [
  'attempt',
  'authorizationDecisionId',
  'capabilityVersionId',
  'externalTraceId',
  'finishedAt',
  'inputTokens',
  'modelOrEngineVersion',
  'observedProvider',
  'outputTokens',
  'promptOrConfigVersion',
  'provider',
  'providerVersion',
  'succeeded',
] as const;

function modelRunsMatch(
  runs: readonly ModelRunRecord[],
  authorization: StoredGenerationRequest['authorization'],
  capability: GeneratedLearningCapability,
  requireSuccess: boolean,
): boolean {
  let hasSuccess = false;
  for (const run of runs) {
    if (
      typeof run !== 'object' ||
      run === null ||
      Object.keys(run).length !== MODEL_RUN_FIELDS.length ||
      !MODEL_RUN_FIELDS.every((field) => Object.hasOwn(run, field)) ||
      !Number.isInteger(run.attempt) ||
      run.attempt < 1 ||
      run.authorizationDecisionId !== authorization.decisionId ||
      run.capabilityVersionId !== capability.id ||
      run.provider !== capability.provider.id ||
      run.providerVersion !== capability.provider.version ||
      run.modelOrEngineVersion !== capability.modelOrEngine.version ||
      run.promptOrConfigVersion !== capability.promptOrConfig.version ||
      (run.observedProvider !== null &&
        (typeof run.observedProvider !== 'string' || run.observedProvider.trim().length === 0)) ||
      (run.externalTraceId !== null &&
        (typeof run.externalTraceId !== 'string' || run.externalTraceId.trim().length === 0)) ||
      !Number.isFinite(Date.parse(run.finishedAt)) ||
      (run.inputTokens !== null &&
        (!Number.isSafeInteger(run.inputTokens) || run.inputTokens < 0)) ||
      (run.outputTokens !== null &&
        (!Number.isSafeInteger(run.outputTokens) || run.outputTokens < 0)) ||
      typeof run.succeeded !== 'boolean' ||
      (run.succeeded && run.observedProvider !== capability.provider.id)
    ) {
      return false;
    }
    hasSuccess ||= run.succeeded;
  }
  return !requireSuccess || hasSuccess;
}

function allRequiredChecksPass(checks: readonly GenerationCheck[]): boolean {
  return (
    checks.length === REQUIRED_GENERATION_CHECKS.size &&
    checks.every(({ kind, passed }) => passed && REQUIRED_GENERATION_CHECKS.has(kind)) &&
    new Set(checks.map(({ kind }) => kind)).size === REQUIRED_GENERATION_CHECKS.size
  );
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

function legacyAuthorization(row: RequestRow): StoredGenerationRequest['authorization'] {
  return {
    containmentEpoch: 0,
    degradedReason: 'NO_SIGNED_CAPABILITY',
    decisionId: `legacy-unverified:${row.id}`,
    issuedAt: timestamp(row.created_at),
  };
}

export class PostgresGeneratedLearningStore
  implements GeneratedLearningStore, GenerationPublicationGate
{
  constructor(private readonly pool: Pool) {}

  async authorize(input: Parameters<GenerationPublicationGate['authorize']>[0]): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      await this.#setFamily(client, input.familySpaceId);
      const result = await client.query<{ authorized: boolean }>(
        `SELECT learning.authorize_generated_learning($1, $2, $3, $4) AS authorized`,
        [input.learningProfileId, input.familySpaceId, input.consentRevision, input.ageBand],
      );
      return result.rows[0]?.authorized === true;
    });
  }

  async cancel(input: Parameters<GeneratedLearningStore['cancel']>[0]): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const request = await this.#readRequest(client, input.requestId);
      if (
        !request ||
        request.state_revision !== input.expectedStateRevision ||
        !['queued', 'generating'].includes(request.status)
      ) {
        return false;
      }
      const result = await client.query<{ canceled: boolean }>(
        `SELECT learning.cancel_generated_learning_request(
           $1, $2, $3, $4, $5
         ) AS canceled`,
        [
          input.requestId,
          input.learningProfileId,
          input.expectedStateRevision,
          randomUUID(),
          input.updatedAt,
        ],
      );
      return result.rows[0]?.canceled === true;
    });
  }

  async complete(
    input: Parameters<GeneratedLearningStore['complete']>[0],
  ): Promise<GenerationCompletionResult> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const request = await this.#readRequest(client, input.requestId);
      if (
        !request ||
        request.status !== 'generating' ||
        request.state_revision !== input.expectedStateRevision ||
        request.current_version_id !== null
      ) {
        return 'conflict';
      }
      const source = json<GenerationSourceSnapshot>(request.source_snapshot);
      const capability = json<StoredGenerationRequest['capability']>(request.capability);
      const authorization = json<StoredGenerationRequest['authorization']>(request.authorization);
      if (
        !capability ||
        !isDeepStrictEqual(input.version.capability, capability) ||
        !isDeepStrictEqual(input.version.authorization, authorization) ||
        !isDeepStrictEqual(input.version.source, source) ||
        !isDeepStrictEqual(input.version.checks, input.latestChecks) ||
        !allRequiredChecksPass(input.latestChecks) ||
        !modelRunsMatch(input.modelRuns, authorization, capability, true)
      ) {
        return 'conflict';
      }

      await this.#setFamily(client, request.family_space_id);
      const result = await client.query<{ result: GenerationCompletionResult }>(
        `SELECT learning.complete_generated_learning_request(
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
           $12::jsonb, $13::jsonb, $14::jsonb, $15
         ) AS result`,
        [
          input.requestId,
          input.learningProfileId,
          input.expectedStateRevision,
          input.version.id,
          input.version.predecessorId,
          input.version.revision,
          input.version.contentState,
          JSON.stringify(input.version.authorization),
          JSON.stringify(input.version.capability),
          JSON.stringify(input.version.source),
          JSON.stringify(input.version.pack),
          JSON.stringify(input.version.checks),
          JSON.stringify(input.latestChecks),
          JSON.stringify(input.modelRuns),
          input.version.createdAt,
        ],
      );
      return result.rows[0]?.result ?? 'conflict';
    });
  }

  async create(request: StoredGenerationRequest): Promise<boolean> {
    if (request.modelRuns.length !== 0) return false;
    return this.#withProfile(request.learningProfileId, async (client) => {
      await this.#setFamily(client, request.familySpaceId);
      const inserted = await client.query<{ created: boolean }>(
        `SELECT learning.create_generated_learning_request(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19,
           $20, $21::jsonb, $22::jsonb, $23, $24
         ) AS created`,
        [
          request.id,
          request.familySpaceId,
          request.learningProfileId,
          request.materialId,
          request.idempotencyKey,
          request.requestFingerprint,
          request.purpose,
          request.actor.type,
          request.actor.id,
          request.consentRevision,
          JSON.stringify(request.authorization),
          request.capability ? JSON.stringify(request.capability) : null,
          JSON.stringify(request.source),
          generatedLearningSourceKey(request.source),
          request.status,
          request.unavailableReason,
          request.currentVersionId,
          request.revealedHintLevel,
          request.processingLeaseExpiresAt,
          request.stateRevision,
          JSON.stringify(request.latestChecks),
          JSON.stringify(request.modelRuns),
          request.createdAt,
          request.updatedAt,
        ],
      );
      return inserted.rows[0]?.created === true;
    });
  }

  async fail(input: Parameters<GeneratedLearningStore['fail']>[0]): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const request = await this.#readRequest(client, input.requestId);
      if (
        !request ||
        request.status !== 'generating' ||
        request.state_revision !== input.expectedStateRevision
      ) {
        return false;
      }
      const capability = json<StoredGenerationRequest['capability']>(request.capability);
      const authorization = json<StoredGenerationRequest['authorization']>(request.authorization);
      if (
        input.modelRuns.length > 0 &&
        (!capability || !modelRunsMatch(input.modelRuns, authorization, capability, false))
      ) {
        return false;
      }
      const result = await client.query<{ failed: boolean }>(
        `SELECT learning.fail_generated_learning_request(
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8
         ) AS failed`,
        [
          input.requestId,
          input.learningProfileId,
          input.expectedStateRevision,
          input.reason,
          JSON.stringify(input.latestChecks),
          JSON.stringify(input.modelRuns),
          randomUUID(),
          input.updatedAt,
        ],
      );
      return result.rows[0]?.failed === true;
    });
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    learningProfileId: string,
  ): Promise<StoredGenerationRequest | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<RequestRow>(
        `${this.#requestSelect()}
         WHERE idempotency_key = $1 AND learning_profile_id = $2`,
        [idempotencyKey, learningProfileId],
      );
      return result.rows[0] ? this.#hydrateRequest(client, result.rows[0]) : null;
    });
  }

  async findLatestReadyForSource(
    requestedSourceKey: string,
    learningProfileId: string,
  ): Promise<StoredGenerationRequest | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<RequestRow>(
        `${this.#requestSelect()}
         WHERE source_key = $1 AND learning_profile_id = $2 AND status = 'ready'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [requestedSourceKey, learningProfileId],
      );
      return result.rows[0] ? this.#hydrateRequest(client, result.rows[0]) : null;
    });
  }

  async findById(id: string, learningProfileId: string): Promise<StoredGenerationRequest | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<RequestRow>(
        `${this.#requestSelect()}
         WHERE id = $1 AND learning_profile_id = $2`,
        [id, learningProfileId],
      );
      return result.rows[0] ? this.#hydrateRequest(client, result.rows[0]) : null;
    });
  }

  async markGenerating(
    input: Parameters<GeneratedLearningStore['markGenerating']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const result = await client.query<{ claimed: boolean }>(
        `SELECT learning.claim_generated_learning_request(
           $1, $2, $3, $4, $5, $6
         ) AS claimed`,
        [
          input.requestId,
          input.learningProfileId,
          input.expectedStateRevision,
          input.leaseExpiresAt,
          input.now,
          input.updatedAt,
        ],
      );
      return result.rows[0]?.claimed === true;
    });
  }

  async recordHintUsage(
    input: Parameters<GeneratedLearningStore['recordHintUsage']>[0],
  ): Promise<GenerationCompletionResult> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const request = await this.#readRequest(client, input.requestId);
      if (
        !request ||
        request.status !== 'ready' ||
        request.current_version_id !== input.versionId ||
        request.revealed_hint_level !== input.expectedLevel ||
        input.nextLevel !== input.expectedLevel + 1
      ) {
        return 'conflict';
      }
      await this.#setFamily(client, request.family_space_id);
      const capability = json<StoredGenerationRequest['capability']>(request.capability);
      if (!capability) return 'capability_unavailable';
      const usageId = randomUUID();
      const result = await client.query<{ result: GenerationCompletionResult }>(
        `SELECT learning.reveal_generated_learning_hint(
           $1, $2, $3, $4, $5, $6, $7, $8, $9
         ) AS result`,
        [
          input.requestId,
          input.learningProfileId,
          input.versionId,
          input.expectedLevel,
          input.nextLevel,
          usageId,
          input.actor.type,
          input.actor.id,
          input.occurredAt,
        ],
      );
      return result.rows[0]?.result ?? 'conflict';
    });
  }

  async #hydrateRequest(client: PoolClient, row: RequestRow): Promise<StoredGenerationRequest> {
    const versions = await client.query<VersionRow>(
      `SELECT id, revision, predecessor_id, content_state,
              authorization_snapshot AS authorization, capability,
              source_snapshot, pack, checks, created_at
       FROM learning.generated_learning_content_versions
       WHERE request_id = $1
       ORDER BY revision`,
      [row.id],
    );
    const authorization =
      row.authorization === null
        ? legacyAuthorization(row)
        : json<StoredGenerationRequest['authorization']>(row.authorization);
    return {
      actor: { id: row.actor_id, type: row.actor_type },
      authorization,
      capability:
        row.authorization === null
          ? null
          : json<StoredGenerationRequest['capability']>(row.capability),
      consentRevision: row.consent_revision,
      createdAt: timestamp(row.created_at),
      currentVersionId: row.current_version_id,
      familySpaceId: row.family_space_id,
      id: row.id,
      idempotencyKey: row.idempotency_key,
      latestChecks: json<GenerationCheck[]>(row.latest_checks),
      learningProfileId: row.learning_profile_id,
      materialId: row.material_id,
      modelRuns: json<ModelRunRecord[]>(row.model_runs),
      processingLeaseExpiresAt: row.processing_lease_expires_at
        ? timestamp(row.processing_lease_expires_at)
        : null,
      purpose: row.purpose,
      requestFingerprint: row.request_fingerprint,
      revealedHintLevel: row.revealed_hint_level,
      source: json<GenerationSourceSnapshot>(row.source_snapshot),
      stateRevision: row.state_revision,
      status: row.status,
      unavailableReason: row.unavailable_reason,
      updatedAt: timestamp(row.updated_at),
      versions: versions.rows.map((version) => ({
        authorization:
          version.authorization === null
            ? structuredClone(authorization)
            : json<GeneratedLearningContentVersion['authorization']>(version.authorization),
        capability: json<GeneratedLearningContentVersion['capability']>(version.capability),
        checks: json<GenerationCheck[]>(version.checks),
        contentState: version.content_state,
        createdAt: timestamp(version.created_at),
        id: version.id,
        pack: json<GeneratedLearningContentVersion['pack']>(version.pack),
        predecessorId: version.predecessor_id,
        revision: version.revision,
        source: json<GenerationSourceSnapshot>(version.source_snapshot),
      })),
    };
  }

  async #readRequest(client: PoolClient, requestId: string): Promise<RequestRow | null> {
    const result = await client.query<RequestRow>(
      `${this.#requestSelect()}
       WHERE id = $1`,
      [requestId],
    );
    return result.rows[0] ?? null;
  }

  #requestSelect(): string {
    return `SELECT id, family_space_id, learning_profile_id, material_id,
                   idempotency_key, request_fingerprint, purpose,
                   actor_type, actor_id, consent_revision,
                   authorization_snapshot AS authorization, capability,
                   source_snapshot, source_key, status, unavailable_reason,
                   current_version_id, revealed_hint_level,
                   processing_lease_expires_at, state_revision,
                   latest_checks, model_runs, created_at, updated_at
            FROM learning.generated_learning_requests`;
  }

  async #setFamily(client: PoolClient, familySpaceId: string): Promise<void> {
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
  }

  async #withProfile<Value>(
    learningProfileId: string,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_generated_learning_app');
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        learningProfileId,
      ]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresGeneratedLearningStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresGeneratedLearningStore(pool);
  return { pool, publicationGate: store, store };
}
