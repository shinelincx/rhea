CREATE OR REPLACE FUNCTION learning.lock_current_generated_learning_basis(
  p_learning_profile_id uuid,
  p_family_space_id uuid,
  p_material_id uuid,
  p_confirmed_content_version_id uuid,
  p_source_version_id uuid,
  p_selection_version integer,
  p_validity_epoch integer,
  p_content_hash text,
  p_kind text,
  p_version_label text,
  p_classification_revision integer,
  p_subject text,
  p_course_path_name text,
  p_unit_name text,
  p_knowledge_point_names text[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE
  v_classification_id uuid;
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
       current_setting('rhea.learning_profile_id', true)
     OR p_family_space_id::text IS DISTINCT FROM
       current_setting('rhea.family_space_id', true) THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM learning.learning_materials material
  WHERE material.id = p_material_id
    AND material.family_space_id = p_family_space_id
    AND material.learning_profile_id = p_learning_profile_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT classification.id
  INTO v_classification_id
  FROM learning.classification_versions classification
  WHERE classification.material_id = p_material_id
  ORDER BY classification.revision DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM learning.learning_materials material
  JOIN LATERAL (
    SELECT selection.version, selection.source_version_id,
           selection.family_space_id, selection.learning_profile_id
    FROM learning.basis_selection_versions selection
    WHERE selection.material_id = material.id
    ORDER BY selection.version DESC
    LIMIT 1
  ) selection ON true
  JOIN learning.learning_source_versions source
    ON source.id = selection.source_version_id
   AND source.material_id = material.id
   AND source.family_space_id = material.family_space_id
   AND source.learning_profile_id = material.learning_profile_id
  JOIN learning.classification_versions classification
    ON classification.id = v_classification_id
   AND classification.material_id = material.id
   AND classification.family_space_id = material.family_space_id
   AND classification.learning_profile_id = material.learning_profile_id
  LEFT JOIN learning.course_paths course_path
    ON course_path.id = classification.course_path_id
  LEFT JOIN learning.learning_units unit_record
    ON unit_record.id = classification.unit_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      array_agg(point.name ORDER BY link.position)
        FILTER (WHERE point.id IS NOT NULL),
      ARRAY[]::text[]
    ) AS names
    FROM learning.classification_knowledge_points link
    JOIN learning.knowledge_points point
      ON point.id = link.knowledge_point_id
    WHERE link.classification_version_id = classification.id
  ) knowledge_points
  WHERE material.id = p_material_id
    AND material.family_space_id = p_family_space_id
    AND material.learning_profile_id = p_learning_profile_id
    AND material.confirmed_content_version_id = p_confirmed_content_version_id
    AND material.invalidated_at IS NULL
    AND material.validity_epoch = p_validity_epoch
    AND selection.version = p_selection_version
    AND selection.family_space_id = material.family_space_id
    AND selection.learning_profile_id = material.learning_profile_id
    AND source.id = p_source_version_id
    AND source.source_confirmed_content_version_id = p_confirmed_content_version_id
    AND source.content_hash = p_content_hash
    AND source.kind = p_kind
    AND source.version_label = p_version_label
    AND NOT EXISTS (
      SELECT 1
      FROM learning.learning_source_versions conflict_left
      JOIN learning.learning_source_versions conflict_right
        ON conflict_right.material_id = conflict_left.material_id
       AND conflict_right.id <> conflict_left.id
       AND conflict_right.content_hash <> conflict_left.content_hash
      WHERE conflict_left.material_id = material.id
        AND (
          conflict_left.source_key = conflict_right.source_key
          OR conflict_right.id = ANY(conflict_left.conflicts_with_source_version_ids)
        )
    )
    AND classification.revision = p_classification_revision
    AND classification.primary_subject = p_subject
    AND course_path.name IS NOT DISTINCT FROM p_course_path_name
    AND unit_record.name IS NOT DISTINCT FROM p_unit_name
    AND knowledge_points.names = p_knowledge_point_names;

  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION learning.lock_current_generated_learning_basis(
  uuid, uuid, uuid, uuid, uuid, integer, integer, text, text, text,
  integer, text, text, text, text[]
) FROM PUBLIC;
