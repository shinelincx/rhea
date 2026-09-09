CREATE TABLE learning.objective_assessments (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES learning.learning_materials(id) ON DELETE CASCADE,
  deduplication_key text NOT NULL CHECK (deduplication_key ~ '^[0-9a-f]{64}$'),
  current_version_id uuid,
  open_dispute_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE (learning_profile_id, id),
  UNIQUE (learning_profile_id, deduplication_key)
);

CREATE TABLE learning.objective_assessment_versions (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  question jsonb NOT NULL,
  response jsonb NOT NULL,
  grading_rule jsonb,
  decision jsonb NOT NULL,
  basis_source_version_id uuid NOT NULL REFERENCES learning.learning_source_versions(id),
  basis_selection_version integer NOT NULL CHECK (basis_selection_version > 0),
  basis_validity_epoch integer NOT NULL CHECK (basis_validity_epoch > 0),
  basis_content_hash text NOT NULL CHECK (basis_content_hash ~ '^[0-9a-f]{64}$'),
  basis_kind text NOT NULL CHECK (basis_kind IN ('learning_material', 'question', 'answer', 'grading_basis')),
  basis_version_label text NOT NULL,
  predecessor_id uuid REFERENCES learning.objective_assessment_versions(id),
  created_by_type text NOT NULL CHECK (created_by_type IN ('guardian', 'learner')),
  created_by_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (assessment_id, revision)
);

CREATE TABLE learning.assessment_disputes (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('assessment', 'question', 'response')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  correction_text text NOT NULL CHECK (char_length(correction_text) BETWEEN 1 AND 4000),
  raised_by_type text NOT NULL CHECK (raised_by_type IN ('guardian', 'learner')),
  raised_by_id uuid NOT NULL,
  raised_at timestamptz NOT NULL,
  UNIQUE (assessment_id, id)
);

CREATE TABLE learning.assessment_dispute_resolutions (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  dispute_id uuid NOT NULL UNIQUE REFERENCES learning.assessment_disputes(id),
  prior_assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  resulting_assessment_version_id uuid NOT NULL REFERENCES learning.objective_assessment_versions(id),
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  resolved_by_type text NOT NULL CHECK (resolved_by_type = 'guardian'),
  resolved_by_id uuid NOT NULL,
  resolved_at timestamptz NOT NULL
);

ALTER TABLE learning.objective_assessments
  ADD CONSTRAINT objective_assessments_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES learning.objective_assessment_versions(id),
  ADD CONSTRAINT objective_assessments_open_dispute_fk
    FOREIGN KEY (open_dispute_id) REFERENCES learning.assessment_disputes(id);

CREATE TABLE learning.assessment_access_audit (
  id bigserial PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('guardian', 'learner')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  assessment_id uuid NOT NULL REFERENCES learning.objective_assessments(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX objective_assessments_profile_time_idx
  ON learning.objective_assessments (learning_profile_id, created_at DESC);
CREATE INDEX objective_assessment_versions_history_idx
  ON learning.objective_assessment_versions (assessment_id, revision DESC);
CREATE INDEX assessment_disputes_history_idx
  ON learning.assessment_disputes (assessment_id, raised_at DESC);
CREATE INDEX assessment_access_audit_profile_time_idx
  ON learning.assessment_access_audit (learning_profile_id, occurred_at DESC);

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

ALTER TABLE learning.objective_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.objective_assessment_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_dispute_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_dispute_resolutions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assessment_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY objective_assessments_profile_isolation ON learning.objective_assessments
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY objective_assessment_versions_profile_isolation ON learning.objective_assessment_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY assessment_disputes_profile_isolation ON learning.assessment_disputes
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY assessment_dispute_resolutions_profile_isolation ON learning.assessment_dispute_resolutions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY assessment_access_audit_profile_isolation ON learning.assessment_access_audit
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_assessment_app') THEN
    CREATE ROLE rhea_assessment_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_assessment_app SET search_path = pg_catalog, learning;
REVOKE ALL ON SCHEMA learning FROM rhea_assessment_app;
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM rhea_assessment_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA learning FROM rhea_assessment_app;
GRANT USAGE ON SCHEMA learning TO rhea_assessment_app;
GRANT EXECUTE ON FUNCTION learning.lock_current_assessment_basis(
  uuid, uuid, uuid, integer, integer, text, text, text
) TO rhea_assessment_app;
GRANT SELECT, INSERT, UPDATE ON learning.objective_assessments TO rhea_assessment_app;
GRANT SELECT, INSERT ON
  learning.objective_assessment_versions,
  learning.assessment_disputes,
  learning.assessment_dispute_resolutions
TO rhea_assessment_app;
GRANT INSERT ON
  learning.domain_outbox,
  learning.assessment_access_audit
TO rhea_assessment_app;
GRANT USAGE, SELECT ON SEQUENCE learning.assessment_access_audit_id_seq TO rhea_assessment_app;

DO $$
BEGIN
  EXECUTE format('GRANT rhea_assessment_app TO %I', current_user);
END
$$;
