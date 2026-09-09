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
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface MaterialRow extends QueryResultRow {
  confirmed_content_version_id: string;
  created_at: Date;
  family_space_id: string;
  id: string;
  learning_profile_id: string;
  source_hash: string;
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
  content_hash: string;
  created_at: Date;
  created_by_id: string;
  created_by_type: LearningSourceVersion['createdBy']['type'];
  id: string;
  kind: LearningSourceVersion['kind'];
  label: string;
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

export class PostgresLearningContentStore implements LearningContentStore {
  constructor(private readonly pool: Pool) {}

  async createMaterial(material: StoredLearningMaterial): Promise<boolean> {
    return this.#withProfile(material.learningProfileId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO learning.learning_materials
          (id, family_space_id, learning_profile_id, confirmed_content_version_id,
           source_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (learning_profile_id, confirmed_content_version_id) DO NOTHING`,
        [
          material.id,
          material.familySpaceId,
          material.learningProfileId,
          material.confirmedContentVersionId,
          material.sourceHash,
          material.createdAt,
        ],
      );
      if (inserted.rowCount !== 1) {
        return false;
      }
      await this.#insertClassification(client, material, material.classificationHistory[0]!);
      await this.#insertSourceVersion(client, material, material.sourceVersions[0]!);
      await this.#insertBasisSelection(client, material, material.basisSelectionHistory[0]!);
      return true;
    });
  }

  async appendClassification(
    input: Parameters<LearningContentStore['appendClassification']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (!material) return false;
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
      return true;
    });
  }

  async appendSourceVersion(
    input: Parameters<LearningContentStore['appendSourceVersion']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (!material) return false;
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
      return true;
    });
  }

  async appendBasisSelection(
    input: Parameters<LearningContentStore['appendBasisSelection']>[0],
  ): Promise<boolean> {
    return this.#withProfile(input.learningProfileId, async (client) => {
      const material = await this.#lockMaterial(client, input.materialId, input.learningProfileId);
      if (!material) return false;
      const count = await this.#count(
        client,
        'learning.basis_selection_versions',
        input.materialId,
      );
      if (count !== input.expectedSelectionRevision) return false;
      await this.#insertBasisSelection(client, this.#materialReference(material), input.selection);
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
                source_hash, created_at
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
                source_hash, created_at
         FROM learning.learning_materials WHERE id = $1 AND learning_profile_id = $2`,
        [id, learningProfileId],
      );
      return result.rows[0] ? this.#hydrate(client, result.rows[0]) : null;
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
         label, version_label, content_hash, source_confirmed_content_version_id,
         created_by_type, created_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        source.id,
        material.id,
        material.familySpaceId,
        material.learningProfileId,
        source.kind,
        source.versionNumber,
        source.label,
        source.versionLabel,
        source.contentHash,
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
      `SELECT id, kind, version_number, label, version_label, content_hash,
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
      learningProfileId: row.learning_profile_id,
      sourceHash: row.source_hash,
      sourceVersions: sourceResult.rows.map((source) => ({
        contentHash: source.content_hash,
        createdAt: source.created_at.toISOString(),
        createdBy: { id: source.created_by_id, type: source.created_by_type },
        id: source.id,
        kind: source.kind,
        label: source.label,
        sourceConfirmedContentVersionId: source.source_confirmed_content_version_id,
        versionLabel: source.version_label,
        versionNumber: source.version_number,
      })),
    };
  }

  async #lockMaterial(
    client: PoolClient,
    id: string,
    learningProfileId: string,
  ): Promise<MaterialRow | null> {
    const result = await client.query<MaterialRow>(
      `SELECT id, family_space_id, learning_profile_id, confirmed_content_version_id,
              source_hash, created_at
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
