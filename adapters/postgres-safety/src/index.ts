import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createRequire } from 'node:module';

import { DecryptRequest, EncryptRequest } from '@alicloud/kms20160120';
import { Config as OpenApiConfig } from '@alicloud/openapi-client';
import type {
  MinimalSafetyClassificationRecord,
  SafetyCaseQueueItem,
  SafetyCaseRecord,
  SafetyEscalationStore,
  SupportAccessGrant,
} from '@rhea/safety-escalation';
import { FileWorkloadCredentialsProvider } from '@rhea/workload-credentials-adapter';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const require = createRequire(import.meta.url);
const CredentialConstructor = (
  require('@alicloud/credentials') as {
    default: typeof import('@alicloud/credentials').default;
  }
).default;
const KmsClientConstructor = (
  require('@alicloud/kms20160120') as {
    default: typeof import('@alicloud/kms20160120').default;
  }
).default;

export interface SafetyFieldProtectionPort {
  protect(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; keyId: string }>;
  unprotect?(ciphertext: Uint8Array, keyId: string): Promise<Uint8Array>;
}

export interface SafetyStoreSecurity {
  fieldProtector: SafetyFieldProtectionPort;
  tokenPepper: string;
}

export class LocalSafetyFieldProtector implements SafetyFieldProtectionPort {
  readonly #key: Buffer;
  constructor(
    readonly keyId: string,
    secret: string,
  ) {
    if (secret.length < 24)
      throw new Error('Safety field secret must contain at least 24 characters');
    this.#key = createHash('sha256').update(secret).digest();
  }
  async protect(plaintext: Uint8Array) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([
      iv,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { ciphertext, keyId: this.keyId };
  }
  async unprotect(ciphertext: Uint8Array, keyId: string) {
    if (keyId !== this.keyId) throw new Error('SAFETY_FIELD_KEY_MISMATCH');
    const encrypted = Buffer.from(ciphertext);
    if (encrypted.byteLength < 29) throw new Error('SAFETY_FIELD_CIPHERTEXT_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  }
}

export class ShanghaiKmsSafetyFieldProtector implements SafetyFieldProtectionPort {
  readonly #client: InstanceType<typeof KmsClientConstructor>;
  constructor(
    readonly keyId: string,
    input: {
      credentialsFile: string;
      endpoint?: string;
      expectedRoleArn: string;
      regionId: 'cn-shanghai';
    },
  ) {
    if (!keyId.trim()) throw new Error('Safety KMS key is required');
    const credential = new CredentialConstructor(
      null,
      new FileWorkloadCredentialsProvider(input.credentialsFile, input.expectedRoleArn),
    );
    this.#client = new KmsClientConstructor(
      new OpenApiConfig({
        connectTimeout: 10_000,
        credential,
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        protocol: 'HTTPS',
        readTimeout: 10_000,
        regionId: input.regionId,
      }),
    );
  }
  async protect(plaintext: Uint8Array) {
    const response = await this.#client.encrypt(
      new EncryptRequest({
        encryptionContext: { workload: 'rhea-safety-fields' },
        keyId: this.keyId,
        plaintext: Buffer.from(plaintext).toString('base64'),
      }),
    );
    if (response.body?.keyId !== this.keyId || !response.body.ciphertextBlob) {
      throw new Error('SAFETY_KMS_ENCRYPT_RESPONSE_INVALID');
    }
    return {
      ciphertext: Buffer.from(response.body.ciphertextBlob, 'base64'),
      keyId: this.keyId,
    };
  }
  async unprotect(ciphertext: Uint8Array, keyId: string) {
    if (keyId !== this.keyId) throw new Error('SAFETY_FIELD_KEY_MISMATCH');
    const response = await this.#client.decrypt(
      new DecryptRequest({
        ciphertextBlob: Buffer.from(ciphertext).toString('base64'),
        encryptionContext: { workload: 'rhea-safety-fields' },
      }),
    );
    if (!response.body?.plaintext) throw new Error('SAFETY_KMS_DECRYPT_RESPONSE_INVALID');
    return Buffer.from(response.body.plaintext, 'base64');
  }
}

function required(environment: Record<string, string | undefined>, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required for production safety storage`);
  return value;
}

export function createSafetyStoreSecurity(
  environment: Record<string, string | undefined>,
): SafetyStoreSecurity {
  const production = environment.NODE_ENV === 'production';
  const tokenPepper = production
    ? required(environment, 'SAFETY_TOKEN_PEPPER')
    : (environment.SAFETY_TOKEN_PEPPER ?? 'local-safety-token-pepper-at-least-32-bytes');
  if (tokenPepper.length < 24) {
    throw new Error('SAFETY_TOKEN_PEPPER must contain at least 24 characters');
  }
  if (production) {
    return {
      fieldProtector: new ShanghaiKmsSafetyFieldProtector(
        required(environment, 'SAFETY_KMS_KEY_ID'),
        {
          ...(environment.KMS_ENDPOINT ? { endpoint: environment.KMS_ENDPOINT } : {}),
          credentialsFile: required(environment, 'WORKLOAD_CREDENTIALS_FILE'),
          expectedRoleArn: required(environment, 'WORKLOAD_ROLE_ARN'),
          regionId: 'cn-shanghai',
        },
      ),
      tokenPepper,
    };
  }
  return {
    fieldProtector: new LocalSafetyFieldProtector(
      environment.SAFETY_KMS_KEY_ID ?? 'local-safety-key',
      environment.SAFETY_FIELD_SECRET ?? 'local-safety-field-secret-at-least-32-bytes',
    ),
    tokenPepper,
  };
}

interface GrantRow extends QueryResultRow {
  allowed_record_ids: string[];
  created_at: Date;
  created_by_guardian_id: string;
  expires_at: Date;
  family_space_id: string;
  id: string;
  learning_profile_id: string;
  reason: string;
  revoked_at: Date | null;
  scopes: SupportAccessGrant['scopes'];
  support_principal_id: string;
}

type ChallengeReportReason =
  'other_preset' | 'suspected_cheating' | 'uncomfortable' | 'unsafe_content';

interface ChallengeReportOutboxRow extends QueryResultRow {
  age_band: 'lower_primary' | 'middle_primary' | 'upper_primary';
  created_at: Date;
  id: string;
  report_reason: ChallengeReportReason;
  source_reference_id: string;
  subject_token: string;
}

interface ChallengeReportSubjectMappingRow extends QueryResultRow {
  mapping_role: 'participant' | 'reporter';
  protected_context: Buffer;
  protection_key_id: string;
  subject_token: string;
}

export interface ResolvedChallengeReportSubject {
  familySpaceId: string;
  learningProfileId: string;
  mappingRole: 'participant' | 'reporter';
  subjectToken: string;
}

const CHALLENGE_REPORT_CLASSIFICATION: Record<
  ChallengeReportReason,
  {
    action: 'allow' | 'escalate';
    category: 'dangerous_instruction' | 'none' | 'unsafe_contact';
    content: string;
    severity: 'high' | 'none';
  }
> = {
  other_preset: {
    action: 'allow',
    category: 'none',
    content: '其他预设举报原因',
    severity: 'none',
  },
  suspected_cheating: {
    action: 'allow',
    category: 'none',
    content: '怀疑对方作弊',
    severity: 'none',
  },
  uncomfortable: {
    action: 'escalate',
    category: 'unsafe_contact',
    content: '对方要求私下联系或见面，让我不舒服',
    severity: 'high',
  },
  unsafe_content: {
    action: 'escalate',
    category: 'dangerous_instruction',
    content: '挑战中出现危险挑战或不适合儿童的内容',
    severity: 'high',
  },
};

function grant(row: GrantRow): SupportAccessGrant {
  return {
    allowedRecordIds: row.allowed_record_ids,
    createdAt: row.created_at.toISOString(),
    createdByGuardianId: row.created_by_guardian_id,
    expiresAt: row.expires_at.toISOString(),
    familySpaceId: row.family_space_id,
    id: row.id,
    learningProfileId: row.learning_profile_id,
    reason: row.reason,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    scopes: row.scopes,
    supportPrincipalId: row.support_principal_id,
  };
}

export class PostgresSafetyEscalationStore implements SafetyEscalationStore {
  readonly #fieldProtector: SafetyFieldProtectionPort;
  constructor(
    readonly pool: Pool,
    readonly databaseRole:
      | 'rhea_safety_api'
      | 'rhea_safety_classifier'
      | 'rhea_safety_operator'
      | 'rhea_safety_worker' = 'rhea_safety_worker',
    readonly tokenPepper = 'local-safety-token-pepper-at-least-32-bytes',
    fieldProtector: SafetyFieldProtectionPort = new LocalSafetyFieldProtector(
      'local-safety-key',
      'local-safety-field-secret-at-least-32-bytes',
    ),
  ) {
    if (tokenPepper.length < 24)
      throw new Error('Safety token pepper must contain at least 24 characters');
    this.#fieldProtector = fieldProtector;
  }

  async recordClassification(input: {
    classification: MinimalSafetyClassificationRecord;
    safetyCase: SafetyCaseRecord | null;
  }): Promise<void> {
    const subjectToken = createHmac('sha256', this.tokenPepper)
      .update(
        `safety-subject\0${input.classification.familySpaceId}\0${input.classification.learningProfileId}`,
      )
      .digest('hex');
    const sourceReferenceToken = createHmac('sha256', this.tokenPepper)
      .update(
        `safety-source\0${input.classification.source}\0${input.classification.sourceReferenceId}`,
      )
      .digest('hex');
    const protectedFields = await this.#fieldProtector.protect(
      Buffer.from(
        JSON.stringify({
          category: input.classification.category,
          familySpaceId: input.classification.familySpaceId,
          guardianMayBeInvolved: input.safetyCase?.guardianMayBeInvolved ?? false,
          learningProfileId: input.classification.learningProfileId,
          severity: input.classification.severity,
          sourceReferenceId: input.classification.sourceReferenceId,
        }),
      ),
    );
    const protectedMetadata = {
      protectedContext: Buffer.from(protectedFields.ciphertext).toString('base64'),
      protectionKeyId: protectedFields.keyId,
      sourceReferenceToken,
      subjectToken,
    };
    await this.#withSafety((client) =>
      client
        .query('SELECT safety.record_classification_and_case($1::jsonb,$2::jsonb)', [
          { ...input.classification, ...protectedMetadata },
          input.safetyCase ? { ...input.safetyCase, ...protectedMetadata } : null,
        ])
        .then(() => undefined),
    );
  }

  async processChallengeReportClassifications(
    limit = 20,
  ): Promise<{ claimed: number; failed: number; processed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Challenge report classification limit must be between 1 and 100');
    }
    const jobs = await this.#withSafety((client) =>
      client
        .query<ChallengeReportOutboxRow>(
          'SELECT * FROM safety.claim_challenge_report_classifications($1)',
          [limit],
        )
        .then(({ rows }) => rows),
    );
    let failed = 0;
    let processed = 0;
    for (const job of jobs) {
      try {
        const policy = CHALLENGE_REPORT_CLASSIFICATION[job.report_reason];
        const classificationId = randomUUID();
        const caseId = policy.action === 'escalate' ? randomUUID() : null;
        const protectedFields = await this.#fieldProtector.protect(
          Buffer.from(
            JSON.stringify({
              reportReason: job.report_reason,
              sourceReferenceToken: job.source_reference_id,
              subjectToken: job.subject_token,
            }),
          ),
        );
        const protectedMetadata = {
          protectedContext: Buffer.from(protectedFields.ciphertext).toString('base64'),
          protectionKeyId: protectedFields.keyId,
          sourceReferenceToken: job.source_reference_id,
          subjectToken: job.subject_token,
        };
        const sourceHash = createHash('sha256').update(policy.content).digest('hex');
        const classification = {
          action: policy.action,
          ageBand: job.age_band,
          category: policy.category,
          createdAt: job.created_at.toISOString(),
          id: classificationId,
          severity: policy.severity,
          source: 'challenge_event',
          sourceHash,
          ...protectedMetadata,
        };
        const safetyCase = caseId
          ? {
              ...classification,
              assignedOperatorId: null,
              claimedAt: null,
              claimExpiresAt: null,
              classificationId,
              guardianMayBeInvolved: false,
              id: caseId,
              retryCount: 0,
              status: 'open',
              updatedAt: job.created_at.toISOString(),
            }
          : null;
        const completed = await this.#withSafety(async (client) => {
          const result = await client.query<{ completed: boolean }>(
            'SELECT safety.complete_challenge_report_classification($1,$2::jsonb,$3::jsonb) AS completed',
            [job.id, classification, safetyCase],
          );
          return Boolean(result.rows[0]?.completed);
        });
        if (completed) {
          processed += 1;
        } else {
          failed += 1;
          await this.#withSafety((client) =>
            client
              .query('SELECT safety.fail_challenge_report_classification($1)', [job.id])
              .then(() => undefined),
          );
        }
      } catch {
        failed += 1;
        await this.#withSafety((client) =>
          client
            .query('SELECT safety.fail_challenge_report_classification($1)', [job.id])
            .then(() => undefined),
        );
      }
    }
    return { claimed: jobs.length, failed, processed };
  }

  async purgeExpiredChallengeReportSubjectMappings(occurredAt = new Date().toISOString()) {
    return this.#withSafety(async (client) => {
      const result = await client.query<{ deleted: number }>(
        'SELECT safety.purge_expired_challenge_report_subject_mappings($1) AS deleted',
        [occurredAt],
      );
      return result.rows[0]?.deleted ?? 0;
    });
  }

  async createGrant(value: SupportAccessGrant): Promise<void> {
    await this.#withSafety((client) =>
      client
        .query(
          this.databaseRole === 'rhea_safety_api'
            ? 'SELECT safety.api_create_support_grant($1::jsonb)'
            : `INSERT INTO safety.support_access_grants
       (id, family_space_id, learning_profile_id, created_by_guardian_id,
        support_principal_id, scopes, allowed_record_ids, reason,
        created_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          this.databaseRole === 'rhea_safety_api'
            ? [value]
            : [
                value.id,
                value.familySpaceId,
                value.learningProfileId,
                value.createdByGuardianId,
                value.supportPrincipalId,
                value.scopes,
                value.allowedRecordIds,
                value.reason,
                value.createdAt,
                value.expiresAt,
                value.revokedAt,
              ],
        )
        .then(() => undefined),
    );
  }

  async findGrant(id: string): Promise<SupportAccessGrant | null> {
    return this.#withSafety(async (client) => {
      const result = await client.query<GrantRow>(
        `SELECT id, family_space_id, learning_profile_id, created_by_guardian_id,
                support_principal_id, scopes, allowed_record_ids, reason,
                created_at, expires_at, revoked_at
         FROM ${this.databaseRole === 'rhea_safety_api' ? 'safety.api_find_support_grant($1)' : 'safety.support_access_grants'}
         ${this.databaseRole === 'rhea_safety_api' ? '' : 'WHERE id = $1'}`,
        [id],
      );
      return result.rows[0] ? grant(result.rows[0]) : null;
    });
  }

  async listActionableCases(operatorId: string, limit: number, reason: string, occurredAt: string) {
    return this.#withSafety(async (client) => {
      const result = await client.query<{ items: SafetyCaseQueueItem[] }>(
        'SELECT safety.list_actionable_cases($1,$2,$3,$4) AS items',
        [operatorId, limit, reason, occurredAt],
      );
      return result.rows[0]?.items ?? [];
    });
  }

  async resolveChallengeReportSubjects(input: {
    occurredAt: string;
    operatorId: string;
    reason: string;
    reportId: string;
  }): Promise<ResolvedChallengeReportSubject[]> {
    if (this.databaseRole !== 'rhea_safety_operator') {
      throw new Error('SAFETY_OPERATOR_ROLE_REQUIRED');
    }
    if (!this.#fieldProtector.unprotect) {
      throw new Error('SAFETY_FIELD_DECRYPTION_UNAVAILABLE');
    }
    const rows = await this.#withSafety(async (client) => {
      const result = await client.query<ChallengeReportSubjectMappingRow>(
        `SELECT subject_token,mapping_role,protected_context,protection_key_id
         FROM safety.read_challenge_report_subject_mappings($1,$2,$3,$4)`,
        [input.reportId, input.operatorId, input.reason, input.occurredAt],
      );
      return result.rows;
    });
    return Promise.all(
      rows.map(async (row) => {
        const plaintext = await this.#fieldProtector.unprotect!(
          row.protected_context,
          row.protection_key_id,
        );
        const context = JSON.parse(Buffer.from(plaintext).toString('utf8')) as {
          familySpaceId?: unknown;
          learningProfileId?: unknown;
        };
        if (
          typeof context.familySpaceId !== 'string' ||
          typeof context.learningProfileId !== 'string'
        ) {
          throw new Error('SAFETY_SUBJECT_MAPPING_INVALID');
        }
        return {
          familySpaceId: context.familySpaceId,
          learningProfileId: context.learningProfileId,
          mappingRole: row.mapping_role,
          subjectToken: row.subject_token,
        };
      }),
    );
  }

  async revokeGrant(input: Parameters<SafetyEscalationStore['revokeGrant']>[0]) {
    return this.#withSafety(async (client) => {
      const result = await client.query(
        this.databaseRole === 'rhea_safety_api'
          ? 'SELECT safety.api_revoke_support_grant($1,$2,$3,$4)'
          : `UPDATE safety.support_access_grants SET revoked_at = $4
         WHERE id = $1 AND created_by_guardian_id = $2
           AND family_space_id = $3 AND revoked_at IS NULL`,
        [input.grantId, input.guardianId, input.familySpaceId, input.revokedAt],
      );
      return this.databaseRole === 'rhea_safety_api'
        ? Boolean(
            (result.rows[0] as { api_revoke_support_grant?: boolean } | undefined)
              ?.api_revoke_support_grant,
          )
        : result.rowCount === 1;
    });
  }

  async appendSupportAudit(input: Parameters<SafetyEscalationStore['appendSupportAudit']>[0]) {
    await this.#withSafety((client) =>
      client
        .query(
          this.databaseRole === 'rhea_safety_api'
            ? 'SELECT safety.api_append_support_audit($1::jsonb)'
            : `INSERT INTO safety.support_access_audit
       (grant_id, support_principal_id, scope, record_id, action, allowed, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          this.databaseRole === 'rhea_safety_api'
            ? [input]
            : [
                input.grantId,
                input.supportPrincipalId,
                input.scope,
                input.recordId,
                input.action,
                input.allowed,
                input.occurredAt,
              ],
        )
        .then(() => undefined),
    );
  }

  async operateCase(input: Parameters<SafetyEscalationStore['operateCase']>[0]) {
    return this.#withSafety(async (client) => {
      const result = await client.query<{ applied: boolean }>(
        'SELECT safety.operate_case($1,$2,$3,$4,$5,$6) AS applied',
        [
          input.commandId,
          input.caseId,
          input.operatorId,
          input.action,
          input.reason,
          input.occurredAt,
        ],
      );
      return Boolean(result.rows[0]?.applied);
    });
  }

  async #withSafety<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.databaseRole}`);
      await client.query('SET LOCAL search_path TO pg_catalog, safety');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresSafetyEscalationStore(
  databaseUrl: string,
  databaseRole:
    | 'rhea_safety_api'
    | 'rhea_safety_classifier'
    | 'rhea_safety_operator'
    | 'rhea_safety_worker' = 'rhea_safety_worker',
  security?: { fieldProtector?: SafetyFieldProtectionPort; tokenPepper?: string },
) {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    pool,
    store: new PostgresSafetyEscalationStore(
      pool,
      databaseRole,
      security?.tokenPepper,
      security?.fieldProtector,
    ),
  };
}
