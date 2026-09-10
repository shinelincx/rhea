CREATE TABLE learning.learning_profile_guardian_permissions (
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  guardian_id uuid NOT NULL REFERENCES learning.guardians(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN ('learning_content.edit')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (learning_profile_id, guardian_id, capability)
);

-- Compatibility grant for profiles created before profile-scoped edit permission existed.
ALTER TABLE learning.learning_profiles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.guardian_memberships NO FORCE ROW LEVEL SECURITY;
INSERT INTO learning.learning_profile_guardian_permissions
  (family_space_id, learning_profile_id, guardian_id, capability)
SELECT profile.family_space_id, profile.id, membership.guardian_id, 'learning_content.edit'
FROM learning.learning_profiles profile
JOIN learning.guardian_memberships membership
  ON membership.family_space_id = profile.family_space_id
WHERE membership.status = 'active'
ON CONFLICT DO NOTHING;
ALTER TABLE learning.learning_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.guardian_memberships FORCE ROW LEVEL SECURITY;

CREATE TABLE learning.course_paths (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject IN ('chinese', 'mathematics', 'english', 'science')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (learning_profile_id, subject, name)
);

CREATE TABLE learning.learning_units (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject IN ('chinese', 'mathematics', 'english', 'science')),
  course_path_id uuid REFERENCES learning.course_paths(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX learning_units_identity_idx
  ON learning.learning_units (
    learning_profile_id, subject, COALESCE(course_path_id, '00000000-0000-0000-0000-000000000000'::uuid), name
  );

CREATE TABLE learning.knowledge_points (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject IN ('chinese', 'mathematics', 'english', 'science')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_points_name_lookup_idx
  ON learning.knowledge_points (learning_profile_id, subject, name);

CREATE TABLE learning.learning_materials (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  confirmed_content_version_id uuid NOT NULL REFERENCES learning.confirmed_content_versions(id),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  validity_epoch integer NOT NULL DEFAULT 1 CHECK (validity_epoch > 0),
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, confirmed_content_version_id)
);

CREATE TABLE learning.classification_versions (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES learning.learning_materials(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending', 'classified')),
  primary_subject text CHECK (
    primary_subject IS NULL OR primary_subject IN ('chinese', 'mathematics', 'english', 'science')
  ),
  related_subjects text[] NOT NULL DEFAULT '{}',
  course_path_id uuid REFERENCES learning.course_paths(id),
  unit_id uuid REFERENCES learning.learning_units(id),
  source text NOT NULL CHECK (source IN ('initial', 'correction')),
  predecessor_id uuid REFERENCES learning.classification_versions(id),
  reason text,
  changed_by_type text NOT NULL CHECK (changed_by_type IN ('guardian', 'learner')),
  changed_by_id uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  UNIQUE (material_id, revision),
  CHECK (related_subjects <@ ARRAY['chinese', 'mathematics', 'english', 'science']::text[]),
  CHECK (primary_subject IS NULL OR NOT primary_subject = ANY(related_subjects)),
  CHECK (
    (status = 'pending' AND primary_subject IS NULL AND cardinality(related_subjects) = 0
      AND course_path_id IS NULL AND unit_id IS NULL)
    OR (status = 'classified' AND primary_subject IS NOT NULL)
  )
);

CREATE TABLE learning.classification_knowledge_points (
  classification_version_id uuid NOT NULL REFERENCES learning.classification_versions(id) ON DELETE CASCADE,
  knowledge_point_id uuid NOT NULL REFERENCES learning.knowledge_points(id),
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (classification_version_id, knowledge_point_id),
  UNIQUE (classification_version_id, position)
);

CREATE UNIQUE INDEX classification_one_primary_knowledge_point_idx
  ON learning.classification_knowledge_points (classification_version_id)
  WHERE is_primary;

CREATE TABLE learning.learning_source_versions (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES learning.learning_materials(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('learning_material', 'question', 'answer', 'grading_basis')),
  version_number integer NOT NULL CHECK (version_number > 0),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 160),
  version_label text NOT NULL CHECK (char_length(version_label) BETWEEN 1 AND 120),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  conflicts_with_source_version_ids uuid[] NOT NULL DEFAULT '{}',
  source_confirmed_content_version_id uuid REFERENCES learning.confirmed_content_versions(id),
  created_by_type text NOT NULL CHECK (created_by_type IN ('guardian', 'learner')),
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (material_id, source_key, version_number)
);

CREATE TABLE learning.basis_selection_versions (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES learning.learning_materials(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  source_version_id uuid NOT NULL REFERENCES learning.learning_source_versions(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 120),
  selected_by_type text NOT NULL CHECK (selected_by_type IN ('guardian', 'learner')),
  selected_by_id uuid NOT NULL,
  selected_at timestamptz NOT NULL,
  UNIQUE (material_id, version)
);

CREATE TABLE learning.domain_outbox (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz
);

CREATE TABLE learning.learning_access_audit (
  id bigserial PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX learning_materials_profile_time_idx
  ON learning.learning_materials (learning_profile_id, created_at DESC);
CREATE INDEX classifications_material_revision_idx
  ON learning.classification_versions (material_id, revision DESC);
CREATE INDEX source_versions_material_kind_idx
  ON learning.learning_source_versions (material_id, kind, source_key, version_number DESC);
CREATE INDEX basis_selections_material_version_idx
  ON learning.basis_selection_versions (material_id, version DESC);
CREATE INDEX domain_outbox_unpublished_idx
  ON learning.domain_outbox (occurred_at, id) WHERE published_at IS NULL;
CREATE INDEX learning_access_audit_profile_time_idx
  ON learning.learning_access_audit (learning_profile_id, occurred_at DESC);

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

ALTER TABLE learning.course_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.course_paths FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_units FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.knowledge_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.knowledge_points FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_materials FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.classification_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.classification_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.classification_knowledge_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.classification_knowledge_points FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_source_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_source_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.basis_selection_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.basis_selection_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_profile_guardian_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_profile_guardian_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.domain_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.domain_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.learning_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY course_paths_profile_isolation ON learning.course_paths
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY learning_units_profile_isolation ON learning.learning_units
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY knowledge_points_profile_isolation ON learning.knowledge_points
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY learning_materials_profile_isolation ON learning.learning_materials
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY classification_versions_profile_isolation ON learning.classification_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY classification_knowledge_points_profile_isolation ON learning.classification_knowledge_points
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY learning_source_versions_profile_isolation ON learning.learning_source_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY basis_selection_versions_profile_isolation ON learning.basis_selection_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY learning_profile_guardian_permissions_scope
  ON learning.learning_profile_guardian_permissions
  USING (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    AND guardian_id::text = current_setting('rhea.guardian_id', true)
  )
  WITH CHECK (
    family_space_id::text = current_setting('rhea.family_space_id', true)
    AND guardian_id::text = current_setting('rhea.guardian_id', true)
  );
CREATE POLICY domain_outbox_profile_isolation ON learning.domain_outbox
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY learning_access_audit_profile_isolation ON learning.learning_access_audit
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_learning_app') THEN
    CREATE ROLE rhea_learning_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_learning_app SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_learning_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_learning_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_learning_app;
GRANT USAGE ON SCHEMA learning TO rhea_learning_app;
GRANT SELECT, INSERT, UPDATE ON
  learning.guardians,
  learning.learning_profiles,
  learning.sessions,
  learning.family_consents,
  learning.upload_sessions,
  learning.upload_pages,
  learning.processing_jobs,
  learning.learning_materials
TO rhea_learning_app;
GRANT SELECT, INSERT ON
  learning.family_spaces,
  learning.guardian_memberships,
  learning.registered_devices,
  learning.consent_events,
  learning.learning_profile_guardian_permissions,
  learning.recognition_candidates,
  learning.confirmed_content_versions,
  learning.raw_asset_deletions,
  learning.course_paths,
  learning.learning_units,
  learning.knowledge_points,
  learning.classification_versions,
  learning.classification_knowledge_points,
  learning.learning_source_versions,
  learning.basis_selection_versions,
  learning.domain_outbox
TO rhea_learning_app;
GRANT INSERT ON learning.learning_access_audit TO rhea_learning_app;
GRANT USAGE, SELECT ON SEQUENCE
  learning.raw_asset_deletions_id_seq,
  learning.learning_access_audit_id_seq
TO rhea_learning_app;

DO $$
BEGIN
  EXECUTE format('GRANT rhea_learning_app TO %I', current_user);
END
$$;
