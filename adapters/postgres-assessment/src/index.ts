import type {
  AssessmentDispute,
  AssessmentStore,
  ObjectiveAssessmentDecision,
  ObjectiveAssessmentVersion,
  ObjectiveGradingRule,
  QuestionVersionSnapshot,
  ResponseVersionSnapshot,
  StoredObjectiveAssessment,
} from '@rhea/assessment';
import type { CurrentLearningBasisReference } from '@rhea/learning-content';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface AssessmentRow extends QueryResultRow {
  created_at: Date;
  current_version_id: string | null;
  deduplication_key: string;
  family_space_id: string;
  id: string;
  learning_profile_id: string;
  material_id: string;
  open_dispute_id: string | null;
}

interface VersionRow extends QueryResultRow {
  basis_content_hash: string;
  basis_kind: CurrentLearningBasisReference['kind'];
  basis_selection_version: number;
  basis_source_version_id: string;
  basis_validity_epoch: number;
  basis_version_label: string;
  created_at: Date;
  created_by_id: string;
  created_by_type: ObjectiveAssessmentVersion['createdBy']['type'];
  decision: unknown;
  grading_rule: unknown | null;
  id: string;
  predecessor_id: string | null;
  question: unknown;
  response: unknown;
  revision: number;
}

interface DisputeRow extends QueryResultRow {
  assessment_version_id: string;
  correction_text: string;
  id: string;
  raised_at: Date;
  raised_by_id: string;
  raised_by_type: AssessmentDispute['raisedBy']['type'];
  reason: string;
  target: AssessmentDispute['target'];
}

interface ResolutionRow extends QueryResultRow {
  dispute_id: string;
  id: string;
  prior_assessment_version_id: string;
  reason: string;
  resolved_at: Date;
  resolved_by_id: string;
  resulting_assessment_version_id: string;
}

interface BasisRow extends QueryResultRow {
  content_hash: string;
  invalidated_at: Date | null;
  kind: CurrentLearningBasisReference['kind'];
  selection_version: number;
  source_version_id: string;
  validity_epoch: number;
  version_label: string;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

export class PostgresAssessmentStore implements AssessmentStore {
  constructor(private readonly pool: Pool) {}

  async appendDispute(input: Parameters<AssessmentStore['appendDispute']>[0]): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const assessment = await this.#lockAssessment(
        client,
        input.assessmentId,
        input.learningProfileId,
      );
      if (
        !assessment ||
        assessment.open_dispute_id ||
        assessment.current_version_id !== input.expectedCurrentVersionId
      ) {
        return false;
      }
      const dispute = input.dispute;
      await client.query(
        `INSERT INTO learning.assessment_disputes
          (id, assessment_id, assessment_version_id, family_space_id, learning_profile_id,
           target, reason, correction_text, raised_by_type, raised_by_id, raised_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          dispute.id,
          assessment.id,
          dispute.assessmentVersionId,
          assessment.family_space_id,
          assessment.learning_profile_id,
          dispute.target,
          dispute.reason,
          dispute.correctionText,
          dispute.raisedBy.type,
          dispute.raisedBy.id,
          dispute.raisedAt,
        ],
      );
      await client.query(
        `UPDATE learning.objective_assessments SET open_dispute_id = $1 WHERE id = $2`,
        [dispute.id, assessment.id],
      );
      await this.#recordChange(client, assessment, {
        actor: dispute.raisedBy,
        eventId: dispute.id,
        eventType: 'objective_assessment.disputed',
        occurredAt: dispute.raisedAt,
        payload: {
          assessmentVersionId: dispute.assessmentVersionId,
          disputeId: dispute.id,
          target: dispute.target,
        },
      });
      return true;
    });
  }

  async createAssessment(assessment: StoredObjectiveAssessment): Promise<boolean> {
    return this.#withProfile(assessment.learningProfileId, async (client) => {
      const version = assessment.versions[0];
      if (!version || !(await this.#basisIsCurrent(client, assessment.materialId, version.basis))) {
        return false;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO learning.objective_assessments
          (id, family_space_id, learning_profile_id, material_id, deduplication_key,
           current_version_id, open_dispute_id, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          assessment.id,
          assessment.familySpaceId,
          assessment.learningProfileId,
          assessment.materialId,
          assessment.deduplicationKey,
          version.createdAt,
        ],
      );
      if (!inserted.rows[0]) return false;
      await this.#insertVersion(client, assessment, version);
      await client.query(
        `UPDATE learning.objective_assessments SET current_version_id = $1 WHERE id = $2`,
        [version.id, assessment.id],
      );
      await this.#recordChange(client, this.#storedReference(assessment), {
        actor: version.createdBy,
        eventId: version.id,
        eventType:
          version.decision.outcome === 'ungradable'
            ? 'objective_assessment.ungradable_recorded'
            : 'objective_assessment.graded',
        occurredAt: version.createdAt,
        payload: {
          assessmentVersionId: version.id,
          basisSourceVersionId: version.basis.sourceVersionId,
          outcome: version.decision.outcome,
        },
      });
      return true;
    });
  }

  async findAssessment(
    id: string,
    learningProfileId: string,
  ): Promise<StoredObjectiveAssessment | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<AssessmentRow>(
        `SELECT id, family_space_id, learning_profile_id, material_id, deduplication_key,
                current_version_id, open_dispute_id, created_at
         FROM learning.objective_assessments
         WHERE id = $1 AND learning_profile_id = $2`,
        [id, learningProfileId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const [versions, disputes, resolutions] = await Promise.all([
        client.query<VersionRow>(
          `SELECT id, revision, question, response, grading_rule, decision,
                  basis_source_version_id, basis_selection_version, basis_validity_epoch,
                  basis_content_hash, basis_kind, basis_version_label, predecessor_id,
                  created_by_type, created_by_id, created_at
           FROM learning.objective_assessment_versions
           WHERE assessment_id = $1
           ORDER BY revision`,
          [row.id],
        ),
        client.query<DisputeRow>(
          `SELECT id, assessment_version_id, target, reason, correction_text,
                  raised_by_type, raised_by_id, raised_at
           FROM learning.assessment_disputes
           WHERE assessment_id = $1
           ORDER BY raised_at, id`,
          [row.id],
        ),
        client.query<ResolutionRow>(
          `SELECT id, dispute_id, prior_assessment_version_id,
                  resulting_assessment_version_id, reason, resolved_by_id, resolved_at
           FROM learning.assessment_dispute_resolutions
           WHERE assessment_id = $1
           ORDER BY resolved_at, id`,
          [row.id],
        ),
      ]);
      const hydratedVersions = versions.rows.map((version) => this.#hydrateVersion(row, version));
      if (hydratedVersions.at(-1)?.id !== row.current_version_id) return null;
      return {
        deduplicationKey: row.deduplication_key,
        disputes: disputes.rows.map((dispute) => ({
          assessmentVersionId: dispute.assessment_version_id,
          correctionText: dispute.correction_text,
          id: dispute.id,
          raisedAt: timestamp(dispute.raised_at),
          raisedBy: { id: dispute.raised_by_id, type: dispute.raised_by_type },
          reason: dispute.reason,
          target: dispute.target,
        })),
        familySpaceId: row.family_space_id,
        id: row.id,
        learningProfileId: row.learning_profile_id,
        materialId: row.material_id,
        openDisputeId: row.open_dispute_id,
        resolutions: resolutions.rows.map((resolution) => ({
          disputeId: resolution.dispute_id,
          id: resolution.id,
          priorAssessmentVersionId: resolution.prior_assessment_version_id,
          reason: resolution.reason,
          resolvedAt: timestamp(resolution.resolved_at),
          resolvedBy: { id: resolution.resolved_by_id, type: 'guardian' },
          resultingAssessmentVersionId: resolution.resulting_assessment_version_id,
        })),
        versions: hydratedVersions,
      };
    });
  }

  async findByDeduplicationKey(
    deduplicationKey: string,
    learningProfileId: string,
  ): Promise<StoredObjectiveAssessment | null> {
    const id = await this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id
         FROM learning.objective_assessments
         WHERE deduplication_key = $1 AND learning_profile_id = $2`,
        [deduplicationKey, learningProfileId],
      );
      return result.rows[0]?.id ?? null;
    });
    return id ? this.findAssessment(id, learningProfileId) : null;
  }

  async recordAccess(input: Parameters<AssessmentStore['recordAccess']>[0]): Promise<void> {
    await this.#withProfile(input.learningProfileId, async (client) => {
      await client.query(
        `INSERT INTO learning.assessment_access_audit
          (family_space_id, learning_profile_id, actor_type, actor_id, action, assessment_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.familySpaceId,
          input.learningProfileId,
          input.actor.type,
          input.actor.id,
          input.action,
          input.assessmentId,
        ],
      );
    });
  }

  async resolveDispute(input: Parameters<AssessmentStore['resolveDispute']>[0]): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const assessment = await this.#lockAssessment(
        client,
        input.assessmentId,
        input.learningProfileId,
      );
      if (
        !assessment ||
        assessment.current_version_id !== input.expectedCurrentVersionId ||
        assessment.open_dispute_id !== input.expectedOpenDisputeId ||
        !(await this.#basisIsCurrent(client, assessment.material_id, input.version.basis))
      ) {
        return false;
      }
      const stored = await this.#hydrate(client, assessment);
      if (!stored) return false;
      await this.#insertVersion(client, stored, input.version);
      const resolution = input.resolution;
      await client.query(
        `INSERT INTO learning.assessment_dispute_resolutions
          (id, assessment_id, dispute_id, prior_assessment_version_id,
           resulting_assessment_version_id, family_space_id, learning_profile_id,
           reason, resolved_by_type, resolved_by_id, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'guardian', $9, $10)`,
        [
          resolution.id,
          assessment.id,
          resolution.disputeId,
          resolution.priorAssessmentVersionId,
          resolution.resultingAssessmentVersionId,
          assessment.family_space_id,
          assessment.learning_profile_id,
          resolution.reason,
          resolution.resolvedBy.id,
          resolution.resolvedAt,
        ],
      );
      await client.query(
        `UPDATE learning.objective_assessments
         SET current_version_id = $1, open_dispute_id = NULL
         WHERE id = $2`,
        [input.version.id, assessment.id],
      );
      await this.#recordChange(client, assessment, {
        actor: resolution.resolvedBy,
        eventId: resolution.id,
        eventType: 'objective_assessment.dispute_resolved',
        occurredAt: resolution.resolvedAt,
        payload: {
          disputeId: resolution.disputeId,
          priorAssessmentVersionId: resolution.priorAssessmentVersionId,
          resultingAssessmentVersionId: resolution.resultingAssessmentVersionId,
        },
      });
      return true;
    });
  }

  async #basisIsCurrent(
    client: PoolClient,
    materialId: string,
    expected: CurrentLearningBasisReference,
  ): Promise<boolean> {
    const result = await client.query<BasisRow>(
      `SELECT material.invalidated_at, material.validity_epoch,
              selection.version AS selection_version,
              source.id AS source_version_id, source.content_hash,
              source.kind, source.version_label
       FROM learning.learning_materials material
       JOIN LATERAL (
         SELECT version, source_version_id
         FROM learning.basis_selection_versions
         WHERE material_id = material.id
         ORDER BY version DESC
         LIMIT 1
       ) selection ON true
       JOIN learning.learning_source_versions source ON source.id = selection.source_version_id
       WHERE material.id = $1
       FOR UPDATE OF material`,
      [materialId],
    );
    const current = result.rows[0];
    return Boolean(
      current &&
      !current.invalidated_at &&
      current.validity_epoch === expected.validityEpoch &&
      current.selection_version === expected.selectionVersion &&
      current.source_version_id === expected.sourceVersionId &&
      current.content_hash === expected.contentHash &&
      current.kind === expected.kind &&
      current.version_label === expected.versionLabel,
    );
  }

  async #hydrate(
    client: PoolClient,
    row: AssessmentRow,
  ): Promise<StoredObjectiveAssessment | null> {
    const versions = await client.query<VersionRow>(
      `SELECT id, revision, question, response, grading_rule, decision,
              basis_source_version_id, basis_selection_version, basis_validity_epoch,
              basis_content_hash, basis_kind, basis_version_label, predecessor_id,
              created_by_type, created_by_id, created_at
       FROM learning.objective_assessment_versions
       WHERE assessment_id = $1
       ORDER BY revision`,
      [row.id],
    );
    return {
      deduplicationKey: row.deduplication_key,
      disputes: [],
      familySpaceId: row.family_space_id,
      id: row.id,
      learningProfileId: row.learning_profile_id,
      materialId: row.material_id,
      openDisputeId: row.open_dispute_id,
      resolutions: [],
      versions: versions.rows.map((version) => this.#hydrateVersion(row, version)),
    };
  }

  #hydrateVersion(assessment: AssessmentRow, row: VersionRow): ObjectiveAssessmentVersion {
    return {
      basis: {
        contentHash: row.basis_content_hash,
        kind: row.basis_kind,
        materialId: assessment.material_id,
        selectionVersion: row.basis_selection_version,
        sourceVersionId: row.basis_source_version_id,
        validityEpoch: row.basis_validity_epoch,
        versionLabel: row.basis_version_label,
      },
      createdAt: timestamp(row.created_at),
      createdBy: { id: row.created_by_id, type: row.created_by_type },
      decision: json<ObjectiveAssessmentDecision>(row.decision),
      id: row.id,
      predecessorId: row.predecessor_id,
      question: json<QuestionVersionSnapshot>(row.question),
      response: json<ResponseVersionSnapshot>(row.response),
      revision: row.revision,
      rule: row.grading_rule ? json<ObjectiveGradingRule>(row.grading_rule) : null,
    };
  }

  async #insertVersion(
    client: PoolClient,
    assessment: Pick<StoredObjectiveAssessment, 'familySpaceId' | 'id' | 'learningProfileId'>,
    version: ObjectiveAssessmentVersion,
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.objective_assessment_versions
        (id, assessment_id, family_space_id, learning_profile_id, revision,
         question, response, grading_rule, decision, basis_source_version_id,
         basis_selection_version, basis_validity_epoch, basis_content_hash,
         basis_kind, basis_version_label, predecessor_id, created_by_type,
         created_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        version.id,
        assessment.id,
        assessment.familySpaceId,
        assessment.learningProfileId,
        version.revision,
        JSON.stringify(version.question),
        JSON.stringify(version.response),
        version.rule ? JSON.stringify(version.rule) : null,
        JSON.stringify(version.decision),
        version.basis.sourceVersionId,
        version.basis.selectionVersion,
        version.basis.validityEpoch,
        version.basis.contentHash,
        version.basis.kind,
        version.basis.versionLabel,
        version.predecessorId,
        version.createdBy.type,
        version.createdBy.id,
        version.createdAt,
      ],
    );
  }

  async #lockAssessment(
    client: PoolClient,
    id: string,
    learningProfileId: string,
  ): Promise<AssessmentRow | null> {
    const result = await client.query<AssessmentRow>(
      `SELECT id, family_space_id, learning_profile_id, material_id, deduplication_key,
              current_version_id, open_dispute_id, created_at
       FROM learning.objective_assessments
       WHERE id = $1 AND learning_profile_id = $2
       FOR UPDATE`,
      [id, learningProfileId],
    );
    return result.rows[0] ?? null;
  }

  async #recordChange(
    client: PoolClient,
    assessment: {
      family_space_id: string;
      id: string;
      learning_profile_id: string;
    },
    event: {
      actor: { id: string; type: string };
      eventId: string;
      eventType: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.domain_outbox
        (id, family_space_id, learning_profile_id, aggregate_type,
         aggregate_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, 'objective_assessment', $4, $5, $6::jsonb, $7)`,
      [
        event.eventId,
        assessment.family_space_id,
        assessment.learning_profile_id,
        assessment.id,
        event.eventType,
        JSON.stringify({ actor: event.actor, ...event.payload }),
        event.occurredAt,
      ],
    );
  }

  #storedReference(assessment: StoredObjectiveAssessment) {
    return {
      family_space_id: assessment.familySpaceId,
      id: assessment.id,
      learning_profile_id: assessment.learningProfileId,
    };
  }

  async #withProfile<Value>(
    learningProfileId: string,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_assessment_app');
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

export function createPostgresAssessmentStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresAssessmentStore(pool) };
}
