import type {
  AssessmentDispute,
  AssessmentDisputeResolution,
  AssessmentStore,
  ObjectiveAssessmentDecision,
  ObjectiveAssessmentVersion,
  ObjectiveGradingRule,
  QuestionVersionSnapshot,
  ResponseVersionSnapshot,
  StoredObjectiveAssessment,
} from '@rhea/assessment';
import {
  deriveTrustedBuiltInRule,
  type DownstreamAssessmentRead,
  type ObjectiveAssessmentInputReader,
  type ObjectiveAssessmentInputReference,
  type ResolvedObjectiveAssessmentInput,
} from '@rhea/assessment';
import type { CurrentLearningBasisReference } from '@rhea/learning-content';
import {
  publishArtifactInTransaction,
  syncSourceRevisionInTransaction,
} from '@rhea/postgres-source-lineage';
import { sourceLineageFingerprint, type SourceDependency } from '@rhea/source-lineage';
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
  grading_rule_version_id: string | null;
  grading_rule: unknown | null;
  id: string;
  input_authority: unknown;
  input_reference: unknown;
  predecessor_id: string | null;
  question: unknown;
  requires_professional_review: boolean;
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
  review_route: AssessmentDispute['reviewRoute'];
  target: AssessmentDispute['target'];
}

interface TrustedInputRow extends QueryResultRow {
  grading_rule: unknown | null;
  grading_rule_version_id: string | null;
  question_text: string;
  requires_professional_review: boolean;
  response_text: string;
  subject: ResolvedObjectiveAssessmentInput['question']['subject'];
}

interface ResolutionRow extends QueryResultRow {
  dispute_id: string;
  id: string;
  prior_assessment_version_id: string;
  reason: string;
  resolved_at: Date;
  resolved_by_id: string;
  resolved_by_type: AssessmentDisputeResolution['resolvedBy']['type'];
  resulting_assessment_version_id: string;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

function basisLineageVersion(basis: CurrentLearningBasisReference): string {
  return `${basis.sourceVersionId}:${basis.selectionVersion}:${basis.validityEpoch}`;
}

export class PostgresAssessmentStore implements AssessmentStore, ObjectiveAssessmentInputReader {
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
           target, reason, correction_text, review_route, raised_by_type, raised_by_id, raised_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          dispute.id,
          assessment.id,
          dispute.assessmentVersionId,
          assessment.family_space_id,
          assessment.learning_profile_id,
          dispute.target,
          dispute.reason,
          dispute.correctionText,
          dispute.reviewRoute,
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
          downstreamEligibility: { eligible: false, reason: 'disputed' },
          disputeId: dispute.id,
          reviewRoute: dispute.reviewRoute,
          target: dispute.target,
        },
      });
      return true;
    });
  }

  async createAssessment(assessment: StoredObjectiveAssessment): Promise<boolean> {
    return this.#withProfile(assessment.learningProfileId, async (client) => {
      const version = assessment.versions[0];
      if (
        !version ||
        !(await this.#basisIsCurrent(
          client,
          assessment.learningProfileId,
          assessment.materialId,
          version.basis,
        ))
      ) {
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
      await this.#publishVersionLineage(client, assessment, version);
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
          downstreamEligibility:
            version.decision.outcome === 'ungradable'
              ? { eligible: false, reason: 'ungradable' }
              : { assessmentVersionId: version.id, eligible: true },
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
          `SELECT id, revision, question, response, input_reference, input_authority, grading_rule,
                  grading_rule_version_id, decision, requires_professional_review,
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
                  review_route, raised_by_type, raised_by_id, raised_at
           FROM learning.assessment_disputes
           WHERE assessment_id = $1
           ORDER BY raised_at, id`,
          [row.id],
        ),
        client.query<ResolutionRow>(
          `SELECT id, dispute_id, prior_assessment_version_id,
                  resulting_assessment_version_id, reason, resolved_by_type,
                  resolved_by_id, resolved_at
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
          reviewRoute: dispute.review_route,
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
          resolvedBy: { id: resolution.resolved_by_id, type: resolution.resolved_by_type },
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

  async readDownstreamReference(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    assessmentId: string;
    currentBasis: CurrentLearningBasisReference;
    learningProfileId: string;
  }): Promise<DownstreamAssessmentRead> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const assessment = await this.#lockAssessment(
        client,
        input.assessmentId,
        input.learningProfileId,
      );
      if (!assessment) return { kind: 'not_found' };
      const stored = await this.#hydrate(client, assessment);
      const current = stored?.versions.at(-1);
      if (!stored || !current || current.id !== assessment.current_version_id) {
        return { kind: 'not_found' };
      }
      await client.query(
        `INSERT INTO learning.assessment_access_audit
          (family_space_id, learning_profile_id, actor_type, actor_id, action, assessment_id)
         VALUES ($1, $2, $3, $4, 'assessment.downstream_reference.read', $5)`,
        [
          assessment.family_space_id,
          assessment.learning_profile_id,
          input.actor.type,
          input.actor.id,
          assessment.id,
        ],
      );
      if (
        !(await this.#basisIsCurrent(
          client,
          input.learningProfileId,
          assessment.material_id,
          input.currentBasis,
        )) ||
        current.basis.sourceVersionId !== input.currentBasis.sourceVersionId ||
        current.basis.selectionVersion !== input.currentBasis.selectionVersion ||
        current.basis.validityEpoch !== input.currentBasis.validityEpoch ||
        current.basis.contentHash !== input.currentBasis.contentHash
      ) {
        return { kind: 'basis_changed' };
      }
      if (assessment.open_dispute_id) {
        return { kind: 'ineligible', reason: 'disputed' };
      }
      if (current.decision.outcome === 'ungradable') {
        return { kind: 'ineligible', reason: 'ungradable' };
      }
      return {
        kind: 'eligible',
        reference: {
          assessmentId: assessment.id,
          assessmentVersionId: current.id,
          basisSelectionVersion: current.basis.selectionVersion,
          basisSourceVersionId: current.basis.sourceVersionId,
          basisValidityEpoch: current.basis.validityEpoch,
          outcome: current.decision.outcome,
          questionVersionId: current.question.versionId,
          responseVersionId: current.response.versionId,
          subject: current.question.subject,
        },
      };
    });
  }

  async confirmObjectiveRule(
    input: Parameters<ObjectiveAssessmentInputReader['confirmObjectiveRule']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const result = await client.query<{ confirmed: boolean }>(
        `SELECT learning.confirm_objective_grading_rule(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15::jsonb, $16, $17
         ) AS confirmed`,
        [
          input.learningProfileId,
          input.familySpaceId,
          input.materialId,
          input.reference.processingJobId,
          input.reference.confirmedContentVersionId,
          input.reference.questionRegionId,
          input.reference.responseRegionId,
          input.basis.sourceVersionId,
          input.basis.selectionVersion,
          input.basis.validityEpoch,
          input.basis.contentHash,
          input.basis.kind,
          input.basis.versionLabel,
          input.gradingRuleVersionId,
          JSON.stringify(input.rule),
          input.actor.id,
          input.confirmedAt,
        ],
      );
      if (result.rows[0]?.confirmed !== true) return false;
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        input.familySpaceId,
      ]);
      await syncSourceRevisionInTransaction(client, {
        occurredAt: input.confirmedAt,
        reason: 'guardian confirmed grading basis',
        source: {
          familySpaceId: input.familySpaceId,
          id: `${input.materialId}:${input.reference.confirmedContentVersionId}:${input.reference.questionRegionId}`,
          kind: 'grading_basis',
          learningProfileId: input.learningProfileId,
        },
        version: input.gradingRuleVersionId,
      });
      return true;
    });
  }

  async resolveObjectiveInput(input: {
    actor: { id: string; type: 'guardian' | 'learner' };
    basis: CurrentLearningBasisReference;
    learningProfileId: string;
    materialId: string;
    reference: ObjectiveAssessmentInputReference;
  }): Promise<ResolvedObjectiveAssessmentInput | null> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const result = await client.query<TrustedInputRow>(
        `SELECT question_text, response_text, subject, grading_rule_version_id,
                grading_rule, requires_professional_review
         FROM learning.resolve_objective_assessment_input(
           $1, $2, $3, $4, $5, $6, $7, $8, $9
         )`,
        [
          input.learningProfileId,
          input.materialId,
          input.reference.processingJobId,
          input.reference.confirmedContentVersionId,
          input.reference.questionRegionId,
          input.reference.responseRegionId,
          input.basis.sourceVersionId,
          input.basis.selectionVersion,
          input.basis.validityEpoch,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      const question = {
        subject: row.subject,
        text: row.question_text,
        versionId: `${input.reference.confirmedContentVersionId}:${input.reference.questionRegionId}`,
      };
      const response = {
        text: row.response_text,
        versionId: `${input.reference.confirmedContentVersionId}:${input.reference.responseRegionId}`,
      };
      const storedRule = row.grading_rule ? json<ObjectiveGradingRule>(row.grading_rule) : null;
      const builtIn = storedRule ? null : deriveTrustedBuiltInRule(question);
      return {
        gradingRuleVersionId: row.grading_rule_version_id ?? builtIn?.gradingRuleVersionId ?? null,
        question,
        requiresProfessionalReview: row.requires_professional_review,
        response,
        rule: storedRule ?? builtIn?.rule ?? null,
      };
    });
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
        !(await this.#basisIsCurrent(
          client,
          input.learningProfileId,
          assessment.material_id,
          input.version.basis,
        ))
      ) {
        return false;
      }
      const stored = await this.#hydrate(client, assessment);
      if (!stored) return false;
      await this.#insertVersion(client, stored, input.version);
      await this.#publishVersionLineage(client, stored, input.version);
      const resolution = input.resolution;
      await client.query(
        `INSERT INTO learning.assessment_dispute_resolutions
          (id, assessment_id, dispute_id, prior_assessment_version_id,
           resulting_assessment_version_id, family_space_id, learning_profile_id,
           reason, resolved_by_type, resolved_by_id, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          resolution.id,
          assessment.id,
          resolution.disputeId,
          resolution.priorAssessmentVersionId,
          resolution.resultingAssessmentVersionId,
          assessment.family_space_id,
          assessment.learning_profile_id,
          resolution.reason,
          resolution.resolvedBy.type,
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
          downstreamEligibility:
            input.version.decision.outcome === 'ungradable'
              ? { eligible: false, reason: 'ungradable' }
              : { assessmentVersionId: input.version.id, eligible: true },
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
    learningProfileId: string,
    materialId: string,
    expected: CurrentLearningBasisReference,
  ): Promise<boolean> {
    const result = await client.query<{ is_current: boolean }>(
      `SELECT learning.lock_current_assessment_basis(
         $1, $2, $3, $4, $5, $6, $7, $8
       ) AS is_current`,
      [
        learningProfileId,
        materialId,
        expected.sourceVersionId,
        expected.selectionVersion,
        expected.validityEpoch,
        expected.contentHash,
        expected.kind,
        expected.versionLabel,
      ],
    );
    return result.rows[0]?.is_current === true;
  }

  async #hydrate(
    client: PoolClient,
    row: AssessmentRow,
  ): Promise<StoredObjectiveAssessment | null> {
    const versions = await client.query<VersionRow>(
      `SELECT id, revision, question, response, input_reference, input_authority, grading_rule,
              grading_rule_version_id, decision, requires_professional_review,
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
      gradingRuleVersionId: row.grading_rule_version_id,
      id: row.id,
      inputAuthority: json<ObjectiveAssessmentVersion['inputAuthority']>(row.input_authority),
      inputReference: json<ObjectiveAssessmentInputReference>(row.input_reference),
      predecessorId: row.predecessor_id,
      question: json<QuestionVersionSnapshot>(row.question),
      response: json<ResponseVersionSnapshot>(row.response),
      revision: row.revision,
      rule: row.grading_rule ? json<ObjectiveGradingRule>(row.grading_rule) : null,
      requiresProfessionalReview: row.requires_professional_review,
    };
  }

  async #publishVersionLineage(
    client: PoolClient,
    assessment: Pick<
      StoredObjectiveAssessment,
      'familySpaceId' | 'id' | 'learningProfileId' | 'materialId'
    >,
    version: ObjectiveAssessmentVersion,
  ): Promise<void> {
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
      assessment.familySpaceId,
    ]);
    const scope = {
      familySpaceId: assessment.familySpaceId,
      learningProfileId: assessment.learningProfileId,
    };
    const dependencies: SourceDependency[] = [];
    const sync = async (
      id: string,
      kind: Parameters<typeof syncSourceRevisionInTransaction>[1]['source']['kind'],
      value: string,
      reason: string,
      usage: string,
    ) => {
      const source = await syncSourceRevisionInTransaction(client, {
        occurredAt: version.createdAt,
        reason,
        source: { ...scope, id, kind },
        version: value,
      });
      dependencies.push({ source, usage });
    };
    await sync(
      assessment.materialId,
      'confirmed_content',
      version.inputReference.confirmedContentVersionId,
      'assessment confirmed content snapshot',
      'confirmed_content',
    );
    await sync(
      assessment.materialId,
      'current_learning_basis',
      basisLineageVersion(version.basis),
      'assessment current learning basis snapshot',
      'current_learning_basis',
    );
    await sync(
      `${assessment.materialId}:${version.inputReference.questionRegionId}`,
      'question',
      version.question.versionId,
      'assessment question version',
      'question',
    );
    await sync(
      `${assessment.materialId}:${version.inputReference.responseRegionId}`,
      'response',
      version.response.versionId,
      'assessment response version',
      'response',
    );
    await sync(
      `${assessment.materialId}:${version.question.versionId}`,
      'grading_basis',
      version.gradingRuleVersionId ?? `ungradable:${version.id}`,
      'assessment grading basis version',
      'grading_basis',
    );
    const input = {
      artifact: {
        ...scope,
        id: assessment.id,
        kind: 'assessment' as const,
        rebuildable: true,
        version: version.id,
      },
      commandId: `lineage:assessment:${version.id}`,
      dependencies,
      expectedPreviousVersion: version.predecessorId,
      occurredAt: version.createdAt,
    };
    const saved = await publishArtifactInTransaction(client, input, {
      commandId: input.commandId,
      fingerprint: sourceLineageFingerprint(input),
    });
    if (saved.status === 'conflict' || saved.status === 'idempotency_conflict') {
      throw new Error('Assessment lineage publication conflicted');
    }
  }

  async #insertVersion(
    client: PoolClient,
    assessment: Pick<StoredObjectiveAssessment, 'familySpaceId' | 'id' | 'learningProfileId'>,
    version: ObjectiveAssessmentVersion,
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.objective_assessment_versions
        (id, assessment_id, family_space_id, learning_profile_id, revision,
         question, response, input_reference, input_authority, grading_rule, grading_rule_version_id,
         decision, requires_professional_review, basis_source_version_id,
         basis_selection_version, basis_validity_epoch, basis_content_hash,
         basis_kind, basis_version_label, predecessor_id, created_by_type,
         created_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        version.id,
        assessment.id,
        assessment.familySpaceId,
        assessment.learningProfileId,
        version.revision,
        JSON.stringify(version.question),
        JSON.stringify(version.response),
        JSON.stringify(version.inputReference),
        JSON.stringify(version.inputAuthority),
        version.rule ? JSON.stringify(version.rule) : null,
        version.gradingRuleVersionId,
        JSON.stringify(version.decision),
        version.requiresProfessionalReview,
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

export function createPostgresAssessmentStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresAssessmentStore(pool) };
}
