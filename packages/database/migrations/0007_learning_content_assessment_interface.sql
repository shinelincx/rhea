CREATE OR REPLACE FUNCTION learning.resolve_objective_assessment_basis(
  p_learning_profile_id uuid,
  p_material_id uuid,
  p_confirmed_content_version_id uuid,
  p_basis_source_version_id uuid,
  p_basis_selection_version integer,
  p_basis_validity_epoch integer
) RETURNS TABLE (
  family_space_id uuid,
  subject text,
  requires_professional_review boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT
    material.family_space_id,
    classification.primary_subject,
    cardinality(source.conflicts_with_source_version_ids) > 0
  FROM learning.learning_materials material
  JOIN LATERAL (
    SELECT primary_subject
    FROM learning.classification_versions
    WHERE material_id = material.id
    ORDER BY revision DESC
    LIMIT 1
  ) classification ON classification.primary_subject IS NOT NULL
  JOIN LATERAL (
    SELECT version, source_version_id
    FROM learning.basis_selection_versions
    WHERE material_id = material.id
    ORDER BY version DESC
    LIMIT 1
  ) selection ON true
  JOIN learning.learning_source_versions source ON source.id = selection.source_version_id
  WHERE material.id = p_material_id
    AND material.learning_profile_id = p_learning_profile_id
    AND material.confirmed_content_version_id = p_confirmed_content_version_id
    AND p_learning_profile_id::text = current_setting('rhea.learning_profile_id', true)
    AND material.invalidated_at IS NULL
    AND source.id = p_basis_source_version_id
    AND selection.version = p_basis_selection_version
    AND material.validity_epoch = p_basis_validity_epoch
$$;

REVOKE ALL ON FUNCTION learning.resolve_objective_assessment_basis(
  uuid, uuid, uuid, uuid, integer, integer
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION learning.lock_current_assessment_basis(
  p_learning_profile_id uuid,
  p_material_id uuid,
  p_source_version_id uuid,
  p_selection_version integer,
  p_validity_epoch integer,
  p_content_hash text,
  p_kind text,
  p_version_label text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF p_learning_profile_id::text IS DISTINCT FROM
     current_setting('rhea.learning_profile_id', true) THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM learning.learning_materials material
  WHERE material.id = p_material_id
    AND material.learning_profile_id = p_learning_profile_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM learning.learning_materials material
  JOIN LATERAL (
    SELECT version, source_version_id
    FROM learning.basis_selection_versions
    WHERE material_id = material.id
    ORDER BY version DESC
    LIMIT 1
  ) selection ON true
  JOIN learning.learning_source_versions source ON source.id = selection.source_version_id
  WHERE material.id = p_material_id
    AND material.learning_profile_id = p_learning_profile_id
    AND material.invalidated_at IS NULL
    AND material.validity_epoch = p_validity_epoch
    AND selection.version = p_selection_version
    AND source.id = p_source_version_id
    AND source.content_hash = p_content_hash
    AND source.kind = p_kind
    AND source.version_label = p_version_label
  FOR UPDATE OF material;

  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION learning.lock_current_assessment_basis(
  uuid, uuid, uuid, integer, integer, text, text, text
) FROM PUBLIC;
