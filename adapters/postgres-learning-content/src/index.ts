import type {
  BasisSelectionVersion,
  ClassificationVersion,
  CoursePathReference,
  KnowledgePointReference,
  LearningContentStore,
  LearningSourceVersion,
  LearningUnitReference,
  StoredLearningMaterial,
  Subject,
} from '@rhea/learning-content';
import { syncSourceRevisionInTransaction } from '@rhea/postgres-source-lineage';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface MaterialRow extends QueryResultRow {
  confirmed_content_version_id: string;
  created_at: Date;
  family_space_id: string;
  id: string;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  learning_profile_id: string;
  source_hash: string;
  validity_epoch: number;
}

interface ClassificationRow extends QueryResultRow {
  changed_at: Date;
  changed_by_id: string;
  changed_by_type: ClassificationVersion['changedBy']['type'];
  course_path_id: string | null;
  course_path_name: string | null;
  id: string;
  predecessor_id: string | null;
  primary_subject: Subject | null;
  reason: string | null;
  related_subjects: Subject[];
  revision: number;
  source: ClassificationVersion['source'];
  status: ClassificationVersion['status'];
  unit_id: string | null;
  unit_name: string | null;
}

interface KnowledgePointRow extends QueryResultRow {
  classification_version_id: string;
  id: string;
  is_primary: boolean;
  name: string;
  position: number;
  subject: Subject;
}

interface SourceRow extends QueryResultRow {
  conflicts_with_source_version_ids: string[];
  content_hash: string;
  created_at: Date;
  created_by_id: string;
  created_by_type: LearningSourceVersion['createdBy']['type'];
  id: string;
  kind: LearningSourceVersion['kind'];
  label: string;
  source_key: string;
  source_confirmed_content_version_id: string | null;
  version_label: string;
  version_number: number;
}

interface SelectionRow extends QueryResultRow {
  id: string;
  reason: string;
  selected_at: Date;
  selected_by_id: string;
  selected_by_type: BasisSelectionVersion['selectedBy']['type'];
  source_version_id: string;
  version: number;
}

async function setProfile(client: PoolClient, learningProfileId: string): Promise<void> {
  await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
    learningProfileId,
  ]);
}

function basisLineageVersion(
  sourceVersionId: string,
  selectionVersion: number,
  validityEpoch: number,
): string {
  return `${sourceVersionId}:${selectionVersion}:${validityEpoch}`;
}

export class PostgresLearningContentStore implements LearningContentStore {
  constructor(private readonly pool: Pool) {}

  async createMaterial(material: StoredLearningMaterial): Promise<boolean> {
    return this.#withProfile(material.learningProfileId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO learning.learning_materials
          (id, family_space_id, learning_profile_id, confirmed_content_version_id,
           source_hash, validity_epoch, invalidated_at, invalidation_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (learning_profile_id, confirmed_content_version_id) DO NOTHING`,
        [
          material.id,
          material.familySpaceId,
          material.learningProfileId,
          material.confirmedContentVersionId,
          material.sourceHash,
          material.validityEpoch,
          material.invalidatedAt,
          material.invalidationReason,
          material.createdAt,
        ],
      );
      if (inserted.rowCount !== 1) {
        return false;
      }
      await this.#insertClassification(client, material, material.classificationHistory[0]!);
      await this.#insertSourceVersion(client, material, material.sourceVersions[0]!);
      await this.#insertBasisSelection(client, material, material.basisSelectionHistory[0]!);
      await this.#setFamily(client, material.familySpaceId);
      await this.#syncMaterialSources(client, material);
      await this.#recordChange(client, material, {
        actor: material.classificationHistory[0]!.changedBy,
        eventId: material.id,
        eventType: 'learning_material.organized',
        occurredAt: material.createdAt,
        payload: {
          classificationRevision: 1,
          confirmedContentVersionId: material.confirmedContentVersionId,
          sourceVersionId: material.sourceVersions[0]!.id,
        },
      });
      return true;
    });
  }

  async appendClassification(
    input: Parameters<LearningContentStore['appendClassification']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (
        !material ||
        material.invalidated_at ||
        material.validity_epoch !== input.expectedValidityEpoch
      ) {
        return false;
      }
      const revision = await this.#count(
        client,
        'learning.classification_versions',
        input.materialId,
      );
      if (revision !== input.expectedRevision) return false;
      await this.#insertClassification(
        client,
        this.#materialReference(material),
        input.classification,
      );
      await this.#setFamily(client, material.family_space_id);
      await syncSourceRevisionInTransaction(client, {
        occurredAt: input.classification.changedAt,
        reason: input.classification.reason ?? 'learning classification changed',
        source: {
          familySpaceId: material.family_space_id,
          id: input.materialId,
          kind: 'classification',
          learningProfileId: input.learningProfileId,
        },
        version: `revision:${input.classification.revision}`,
      });
      await this.#recordChange(client, this.#materialReference(material), {
        actor: input.classification.changedBy,
        eventId: input.classification.id,
        eventType: 'learning_material.classification_corrected',
        occurredAt: input.classification.changedAt,
        payload: { classificationRevision: input.classification.revision },
      });
      return true;
    });
  }

  async appendSourceVersion(
    input: Parameters<LearningContentStore['appendSourceVersion']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (
        !material ||
        material.invalidated_at ||
        material.validity_epoch !== input.expectedValidityEpoch
      ) {
        return false;
      }
      const count = await this.#count(
        client,
        'learning.learning_source_versions',
        input.materialId,
      );
      if (count !== input.expectedSourceCount) return false;
      await this.#insertSourceVersion(
        client,
        this.#materialReference(material),
        input.sourceVersion,
      );
      await this.#setFamily(client, material.family_space_id);
      await syncSourceRevisionInTransaction(client, {
        occurredAt: input.sourceVersion.createdAt,
        reason: 'learning source version added',
        source: {
          familySpaceId: material.family_space_id,
          id: `${input.materialId}:${input.sourceVersion.kind}:${input.sourceVersion.sourceKey}`,
          kind: 'learning_source',
          learningProfileId: input.learningProfileId,
        },
        version: `${input.sourceVersion.id}:${input.sourceVersion.versionNumber}:${input.sourceVersion.contentHash}`,
      });
      await this.#recordChange(client, this.#materialReference(material), {
        actor: input.sourceVersion.createdBy,
        eventId: input.sourceVersion.id,
        eventType: 'learning_material.source_version_added',
        occurredAt: input.sourceVersion.createdAt,
        payload: {
          kind: input.sourceVersion.kind,
          sourceVersionId: input.sourceVersion.id,
          versionNumber: input.sourceVersion.versionNumber,
        },
      });
      return true;
    });
  }

  async appendBasisSelection(
    input: Parameters<LearningContentStore['appendBasisSelection']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (
        !material ||
        material.invalidated_at ||
        material.validity_epoch !== input.expectedValidityEpoch
      ) {
        return false;
      }
      const count = await this.#count(
        client,
        'learning.basis_selection_versions',
        input.materialId,
      );
      if (count !== input.expectedSelectionRevision) return false;
      await this.#insertBasisSelection(client, this.#materialReference(material), input.selection);
      await this.#setFamily(client, material.family_space_id);
      await syncSourceRevisionInTransaction(client, {
        occurredAt: input.selection.selectedAt,
        reason: input.selection.reason,
        source: {
          familySpaceId: material.family_space_id,
          id: input.materialId,
          kind: 'current_learning_basis',
          learningProfileId: input.learningProfileId,
        },
        version: basisLineageVersion(
          input.selection.sourceVersionId,
          input.selection.version,
          input.expectedValidityEpoch,
        ),
      });
      await this.#recordChange(client, this.#materialReference(material), {
        actor: input.selection.selectedBy,
        eventId: input.selection.id,
        eventType: 'learning_material.current_basis_selected',
        occurredAt: input.selection.selectedAt,
        payload: {
          selectionVersion: input.selection.version,
          sourceVersionId: input.selection.sourceVersionId,
        },
      });
      return true;
    });
  }

  async findByConfirmedContent(
    confirmedContentVersionId: string,
    learningProfileId: string,
  ): Promise<StoredLearningMaterial | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<MaterialRow>(
        `SELECT id, family_space_id, learning_profile_id, confirmed_content_version_id,
                source_hash, validity_epoch, invalidated_at, invalidation_reason, created_at
         FROM learning.learning_materials
         WHERE confirmed_content_version_id = $1 AND learning_profile_id = $2`,
        [confirmedContentVersionId, learningProfileId],
      );
      return result.rows[0] ? this.#hydrate(client, result.rows[0]) : null;
    });
  }

  async findMaterial(
    id: string,
    learningProfileId: string,
  ): Promise<StoredLearningMaterial | null> {
    return this.#withProfile(learningProfileId, async (client) => {
      const result = await client.query<MaterialRow>(
        `SELECT id, family_space_id, learning_profile_id, confirmed_content_version_id,
                source_hash, validity_epoch, invalidated_at, invalidation_reason, created_at
         FROM learning.learning_materials WHERE id = $1 AND learning_profile_id = $2`,
        [id, learningProfileId],
      );
      return result.rows[0] ? this.#hydrate(client, result.rows[0]) : null;
    });
  }

  async invalidateMaterial(
    input: Parameters<LearningContentStore['invalidateMaterial']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (!material || material.validity_epoch !== input.expectedValidityEpoch) return false;
      const updated = await client.query(
        `UPDATE learning.learning_materials
         SET validity_epoch = validity_epoch + 1, invalidated_at = $3, invalidation_reason = $4
         WHERE id = $1 AND learning_profile_id = $2 AND validity_epoch = $5`,
        [
          input.materialId,
          input.learningProfileId,
          input.invalidatedAt,
          input.reason,
          input.expectedValidityEpoch,
        ],
      );
      if (updated.rowCount !== 1) return false;
      await this.#setFamily(client, material.family_space_id);
      await syncSourceRevisionInTransaction(client, {
        occurredAt: input.invalidatedAt,
        reason: input.reason,
        source: {
          familySpaceId: material.family_space_id,
          id: input.materialId,
          kind: 'current_learning_basis',
          learningProfileId: input.learningProfileId,
        },
        version: `invalidated:${input.expectedValidityEpoch + 1}`,
      });
      await this.#recordChange(client, this.#materialReference(material), {
        actor: input.actor,
        eventId: input.eventId,
        eventType: 'learning_material.upstream_invalidated',
        occurredAt: input.invalidatedAt,
        payload: {
          previousValidityEpoch: input.expectedValidityEpoch,
          reason: input.reason,
        },
      });
      return true;
    });
  }

  async recordAccess(input: Parameters<LearningContentStore['recordAccess']>[0]): Promise<void> {
    await this.#withProfile(input.learningProfileId, async (client) => {
      await this.#insertAccessAudit(client, {
        action: input.action,
        actor: input.actor,
        familySpaceId: input.familySpaceId,
        learningProfileId: input.learningProfileId,
        materialId: input.materialId,
        occurredAt: new Date().toISOString(),
      });
    });
  }

  async #insertClassification(
    client: PoolClient,
    material: Pick<StoredLearningMaterial, 'familySpaceId' | 'id' | 'learningProfileId'>,
    classification: ClassificationVersion,
  ): Promise<void> {
    await this.#upsertTaxonomy(client, material, classification);
    await client.query(
      `INSERT INTO learning.classification_versions
        (id, material_id, family_space_id, learning_profile_id, revision, status,
         primary_subject, related_subjects, course_path_id, unit_id, source,
         predecessor_id, reason, changed_by_type, changed_by_id, changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        classification.id,
        material.id,
        material.familySpaceId,
        material.learningProfileId,
        classification.revision,
        classification.status,
        classification.primarySubject,
        classification.relatedSubjects,
        classification.coursePath?.id ?? null,
        classification.unit?.id ?? null,
        classification.source,
        classification.predecessorId,
        classification.reason,
        classification.changedBy.type,
        classification.changedBy.id,
        classification.changedAt,
      ],
    );
    for (const [position, point] of classification.knowledgePoints.entries()) {
      await client.query(
        `INSERT INTO learning.classification_knowledge_points
          (classification_version_id, knowledge_point_id, learning_profile_id, is_primary, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [classification.id, point.id, material.learningProfileId, point.primary, position],
      );
    }
  }

  async #upsertTaxonomy(
    client: PoolClient,
    material: Pick<StoredLearningMaterial, 'familySpaceId' | 'learningProfileId'>,
    classification: ClassificationVersion,
  ): Promise<void> {
    if (classification.coursePath) {
      await client.query(
        `INSERT INTO learning.course_paths
          (id, family_space_id, learning_profile_id, subject, name)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [
          classification.coursePath.id,
          material.familySpaceId,
          material.learningProfileId,
          classification.coursePath.subject,
          classification.coursePath.name,
        ],
      );
    }
    if (classification.unit) {
      await client.query(
        `INSERT INTO learning.learning_units
          (id, family_space_id, learning_profile_id, subject, course_path_id, name)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [
          classification.unit.id,
          material.familySpaceId,
          material.learningProfileId,
          classification.unit.subject,
          classification.unit.coursePathId,
          classification.unit.name,
        ],
      );
    }
    for (const point of classification.knowledgePoints) {
      await client.query(
        `INSERT INTO learning.knowledge_points
          (id, family_space_id, learning_profile_id, subject, name)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [point.id, material.familySpaceId, material.learningProfileId, point.subject, point.name],
      );
    }
  }

  async #insertSourceVersion(
    client: PoolClient,
    material: Pick<StoredLearningMaterial, 'familySpaceId' | 'id' | 'learningProfileId'>,
    source: LearningSourceVersion,
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.learning_source_versions
        (id, material_id, family_space_id, learning_profile_id, kind, version_number,
         label, source_key, version_label, content_hash, conflicts_with_source_version_ids,
         source_confirmed_content_version_id,
         created_by_type, created_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        source.id,
        material.id,
        material.familySpaceId,
        material.learningProfileId,
        source.kind,
        source.versionNumber,
        source.label,
        source.sourceKey,
        source.versionLabel,
        source.contentHash,
        source.conflictsWithSourceVersionIds,
        source.sourceConfirmedContentVersionId,
        source.createdBy.type,
        source.createdBy.id,
        source.createdAt,
      ],
    );
  }

  async #insertBasisSelection(
    client: PoolClient,
    material: Pick<StoredLearningMaterial, 'familySpaceId' | 'id' | 'learningProfileId'>,
    selection: BasisSelectionVersion,
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.basis_selection_versions
        (id, material_id, family_space_id, learning_profile_id, version, source_version_id,
         reason, selected_by_type, selected_by_id, selected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        selection.id,
        material.id,
        material.familySpaceId,
        material.learningProfileId,
        selection.version,
        selection.sourceVersionId,
        selection.reason,
        selection.selectedBy.type,
        selection.selectedBy.id,
        selection.selectedAt,
      ],
    );
  }

  async #syncMaterialSources(client: PoolClient, material: StoredLearningMaterial): Promise<void> {
    const classification = material.classificationHistory.at(-1)!;
    const source = material.sourceVersions.at(-1)!;
    const selection = material.basisSelectionHistory.at(-1)!;
    const scope = {
      familySpaceId: material.familySpaceId,
      learningProfileId: material.learningProfileId,
    };
    await syncSourceRevisionInTransaction(client, {
      occurredAt: material.createdAt,
      reason: 'confirmed learning content organized',
      source: { ...scope, id: material.id, kind: 'confirmed_content' },
      version: material.confirmedContentVersionId,
    });
    await syncSourceRevisionInTransaction(client, {
      occurredAt: classification.changedAt,
      reason: classification.reason ?? 'initial learning classification',
      source: { ...scope, id: material.id, kind: 'classification' },
      version: `revision:${classification.revision}`,
    });
    await syncSourceRevisionInTransaction(client, {
      occurredAt: source.createdAt,
      reason: 'initial learning source',
      source: {
        ...scope,
        id: `${material.id}:${source.kind}:${source.sourceKey}`,
        kind: 'learning_source',
      },
      version: `${source.id}:${source.versionNumber}:${source.contentHash}`,
    });
    await syncSourceRevisionInTransaction(client, {
      occurredAt: selection.selectedAt,
      reason: selection.reason,
      source: { ...scope, id: material.id, kind: 'current_learning_basis' },
      version: basisLineageVersion(
        selection.sourceVersionId,
        selection.version,
        material.validityEpoch,
      ),
    });
  }

  async #setFamily(client: PoolClient, familySpaceId: string): Promise<void> {
    await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [familySpaceId]);
  }

  async #hydrate(client: PoolClient, row: MaterialRow): Promise<StoredLearningMaterial> {
    const classifications = await client.query<ClassificationRow>(
      `SELECT cv.id, cv.revision, cv.status, cv.primary_subject, cv.related_subjects,
              cv.source, cv.predecessor_id, cv.reason, cv.changed_by_type,
              cv.changed_by_id, cv.changed_at, cv.course_path_id, cp.name AS course_path_name,
              cv.unit_id, lu.name AS unit_name
       FROM learning.classification_versions cv
       LEFT JOIN learning.course_paths cp ON cp.id = cv.course_path_id
       LEFT JOIN learning.learning_units lu ON lu.id = cv.unit_id
       WHERE cv.material_id = $1 ORDER BY cv.revision`,
      [row.id],
    );
    const classificationIds = classifications.rows.map(({ id }) => id);
    const points =
      classificationIds.length > 0
        ? await client.query<KnowledgePointRow>(
            `SELECT ckp.classification_version_id, kp.id, kp.subject, kp.name,
                    ckp.is_primary, ckp.position
             FROM learning.classification_knowledge_points ckp
             JOIN learning.knowledge_points kp ON kp.id = ckp.knowledge_point_id
             WHERE ckp.classification_version_id = ANY($1::uuid[])
             ORDER BY ckp.classification_version_id, ckp.position`,
            [classificationIds],
          )
        : { rows: [] as KnowledgePointRow[] };
    const sourceResult = await client.query<SourceRow>(
      `SELECT id, kind, version_number, label, source_key, version_label, content_hash,
              conflicts_with_source_version_ids,
              source_confirmed_content_version_id, created_by_type, created_by_id, created_at
       FROM learning.learning_source_versions WHERE material_id = $1
       ORDER BY created_at, id`,
      [row.id],
    );
    const selectionResult = await client.query<SelectionRow>(
      `SELECT id, version, source_version_id, reason, selected_by_type,
              selected_by_id, selected_at
       FROM learning.basis_selection_versions WHERE material_id = $1 ORDER BY version`,
      [row.id],
    );
    return {
      basisSelectionHistory: selectionResult.rows.map((selection) => ({
        id: selection.id,
        reason: selection.reason,
        selectedAt: selection.selected_at.toISOString(),
        selectedBy: { id: selection.selected_by_id, type: selection.selected_by_type },
        sourceVersionId: selection.source_version_id,
        version: selection.version,
      })),
      classificationHistory: classifications.rows.map((classification) => ({
        changedAt: classification.changed_at.toISOString(),
        changedBy: { id: classification.changed_by_id, type: classification.changed_by_type },
        coursePath:
          classification.course_path_id &&
          classification.course_path_name &&
          classification.primary_subject
            ? ({
                id: classification.course_path_id,
                name: classification.course_path_name,
                subject: classification.primary_subject,
              } satisfies CoursePathReference)
            : null,
        id: classification.id,
        knowledgePoints: points.rows
          .filter((point) => point.classification_version_id === classification.id)
          .map((point): KnowledgePointReference => ({
            id: point.id,
            name: point.name,
            primary: point.is_primary,
            subject: point.subject,
          })),
        predecessorId: classification.predecessor_id,
        primarySubject: classification.primary_subject,
        reason: classification.reason,
        relatedSubjects: classification.related_subjects,
        revision: classification.revision,
        source: classification.source,
        status: classification.status,
        unit:
          classification.unit_id && classification.unit_name && classification.primary_subject
            ? ({
                coursePathId: classification.course_path_id,
                id: classification.unit_id,
                name: classification.unit_name,
                subject: classification.primary_subject,
              } satisfies LearningUnitReference)
            : null,
      })),
      confirmedContentVersionId: row.confirmed_content_version_id,
      createdAt: row.created_at.toISOString(),
      familySpaceId: row.family_space_id,
      id: row.id,
      invalidatedAt: row.invalidated_at?.toISOString() ?? null,
      invalidationReason: row.invalidation_reason,
      learningProfileId: row.learning_profile_id,
      sourceHash: row.source_hash,
      sourceVersions: sourceResult.rows.map((source) => ({
        conflictsWithSourceVersionIds: source.conflicts_with_source_version_ids,
        contentHash: source.content_hash,
        createdAt: source.created_at.toISOString(),
        createdBy: { id: source.created_by_id, type: source.created_by_type },
        id: source.id,
        kind: source.kind,
        label: source.label,
        sourceKey: source.source_key,
        sourceConfirmedContentVersionId: source.source_confirmed_content_version_id,
        versionLabel: source.version_label,
        versionNumber: source.version_number,
      })),
      validityEpoch: row.validity_epoch,
    };
  }

  async #lockMaterial(
    client: PoolClient,
    id: string,
    learningProfileId: string,
  ): Promise<MaterialRow | null> {
    const result = await client.query<MaterialRow>(
      `SELECT id, family_space_id, learning_profile_id, confirmed_content_version_id,
              source_hash, validity_epoch, invalidated_at, invalidation_reason, created_at
       FROM learning.learning_materials
       WHERE id = $1 AND learning_profile_id = $2 FOR UPDATE`,
      [id, learningProfileId],
    );
    return result.rows[0] ?? null;
  }

  #materialReference(
    row: MaterialRow,
  ): Pick<StoredLearningMaterial, 'familySpaceId' | 'id' | 'learningProfileId'> {
    return {
      familySpaceId: row.family_space_id,
      id: row.id,
      learningProfileId: row.learning_profile_id,
    };
  }

  async #recordChange(
    client: PoolClient,
    material: Pick<StoredLearningMaterial, 'familySpaceId' | 'id' | 'learningProfileId'>,
    change: {
      actor: { id: string; type: 'guardian' | 'learner' };
      eventId: string;
      eventType: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.domain_outbox
        (id, family_space_id, learning_profile_id, aggregate_type, aggregate_id,
         event_type, payload, occurred_at)
       VALUES ($1, $2, $3, 'learning_material', $4, $5, $6, $7)`,
      [
        change.eventId,
        material.familySpaceId,
        material.learningProfileId,
        material.id,
        change.eventType,
        JSON.stringify(change.payload),
        change.occurredAt,
      ],
    );
    await this.#insertAccessAudit(client, {
      action: change.eventType,
      actor: change.actor,
      familySpaceId: material.familySpaceId,
      learningProfileId: material.learningProfileId,
      materialId: material.id,
      occurredAt: change.occurredAt,
    });
  }

  async #insertAccessAudit(
    client: PoolClient,
    input: {
      action: string;
      actor: { id: string; type: 'guardian' | 'learner' | 'professional' };
      familySpaceId: string;
      learningProfileId: string;
      materialId: string;
      occurredAt: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.learning_access_audit
        (family_space_id, learning_profile_id, actor_type, actor_id,
         action, resource_type, resource_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'learning_material', $6, $7)`,
      [
        input.familySpaceId,
        input.learningProfileId,
        input.actor.type,
        input.actor.id,
        input.action,
        input.materialId,
        input.occurredAt,
      ],
    );
  }

  async #count(client: PoolClient, table: string, materialId: string): Promise<number> {
    const allowed = new Set([
      'learning.classification_versions',
      'learning.learning_source_versions',
      'learning.basis_selection_versions',
    ]);
    if (!allowed.has(table)) throw new Error('Unsupported version table');
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE material_id = $1`,
      [materialId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async #withProfile<Result>(
    learningProfileId: string,
    action: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_learning_app');
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      await setProfile(client, learningProfileId);
      const result = await action(client);
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

export function createPostgresLearningContentStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresLearningContentStore(pool) };
}
